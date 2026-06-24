# ML Capacity and Cost Planning

## TL;DR

ML capacity planning is ordinary capacity planning with two expensive twists: accelerators are costly indivisible resources, and model work has high variance. The math is still first principles: request rate, service time, concurrency, utilization, memory, bandwidth, and queueing. But the bottlenecks differ by workload. Online inference is usually governed by p99 latency, batch wait, model load time, accelerator memory, and feature-fetch fanout. Batch inference is governed by throughput and cost per prediction. Training is governed by accelerator-hours, data I/O, checkpointing, and cluster scheduling. The central rule is **size against the bottleneck resource and the percentile that the product experiences, not the average metric the dashboard happens to show.** For GPU serving, that usually means queue depth, batch latency, GPU memory, and utilization — not CPU.

---

## The Units That Matter

Every ML capacity estimate starts with four units:

```text
requests/second       incoming prediction or training examples
seconds/request       service time per item or batch
bytes/request         features, embeddings, prompts, outputs
accelerator memory    model weights + activations + batch/KV/cache state
```

From these, derive the rest:

```text
concurrency = arrival_rate × latency          (Little's law)
throughput_per_replica = batch_size / batch_service_time
replicas = peak_rps / safe_throughput_per_replica
cost_per_prediction = hourly_cost / predictions_per_hour
```

The numbers do not need to be exact at first. They need to be explicit. A wrong estimate with visible assumptions can be corrected. An architecture with no estimate discovers its costs in production.

---

## Serving Regimes Have Different Capacity Goals

The first capacity decision is not hardware. It is serving regime.

| Regime | Goal | Main constraint | Typical metric |
|---|---|---|---|
| Online synchronous | Answer inside user request | p99 latency | p99, timeout rate, queue wait |
| Online async | Process soon after event | queue lag | end-to-end lag, backlog |
| Batch scoring | Finish by deadline cheaply | throughput/cost | predictions/hour, cost/run |
| Training | Produce artifact by deadline | accelerator-hours + I/O | time-to-train, cost/run |

A daily churn score does not need online GPU serving. A checkout fraud decision does. Moving work to the cheapest regime that satisfies freshness is the highest-leverage cost optimization in ML systems.

---

## Online Inference Sizing

For online inference, start with the latency budget and peak traffic.

Example:

```text
Peak traffic: 12,000 RPS
End-to-end p99 budget: 120 ms
Budget allocation:
  ingress/auth         10 ms
  feature fetch        35 ms
  inference            45 ms
  postprocess/logging  15 ms
  network/headroom     15 ms
```

If one model replica can process a batch of 32 in 20 ms, its theoretical throughput is:

```text
32 / 0.020s = 1,600 predictions/s
```

But theoretical throughput is not safe throughput. At high utilization, queueing delay explodes. If the safe target is 65% utilization:

```text
safe_throughput = 1,600 × 0.65 ≈ 1,040 predictions/s
replicas = 12,000 / 1,040 ≈ 12 replicas
```

Then add failure and deploy headroom. If the service must survive one replica or one AZ loss and support rolling deploys, 12 is not enough. The final number may be 16-20 replicas depending on topology.

The key is that batch throughput and latency budget interact. Larger batches raise throughput but add queue wait. A capacity plan that uses max batch throughput without modeling batch wait is optimistic by design.

---

## Dynamic Batching Capacity

Dynamic batching has two knobs: max batch size and max wait. Capacity planning must account for both.

```text
max_batch_size = 32
max_wait = 5 ms
batch_compute_time = 20 ms
```

Under heavy load, batches fill quickly, so the service approaches 32/20ms throughput. Under low load, requests may wait the full 5ms and run smaller batches, lowering utilization. Under bursty load, queues oscillate and p99 can jump.

A simple sizing rule:

```text
per_replica_capacity ≈ effective_batch_size / (batch_compute_time + average_batch_wait)
```

But p99 planning must use tail wait, not average wait. If max wait is 5ms and burst queueing adds 30ms before the request even enters the batch, the inference budget is blown even though GPU utilization looks healthy.

Monitor:

- queue depth,
- queue wait p50/p95/p99,
- effective batch size,
- batch compute time,
- timeout/drop rate,
- GPU utilization and memory.

CPU is not a saturation signal for GPU-bound inference.

---

## Memory Sizing: The Hard Limit

Accelerator memory is a hard capacity boundary. If a batch does not fit, the replica crashes or rejects work. Estimate memory before throughput.

```text
total_memory = model_weights
             + runtime_overhead
             + activation_memory(batch_size, input_shape)
             + cache_memory
             + fragmentation_headroom
```

For classical neural inference, activation memory grows with batch size and input size. For LLMs, KV cache grows with sequence length and concurrent tokens. For recommendation systems, embedding tables may dominate memory, and feature caches may sit outside the model server.

The memory capacity question is:

```text
max_safe_batch = floor((device_memory - weights - overhead - headroom) / per_item_activation)
```

Use headroom. Memory fragmentation, variable input sizes, and framework workspaces make exact fits dangerous. A batch size that works in a benchmark may OOM under production input shape variance.

---

## Feature Fetch Fanout Can Dominate Inference

Many ML serving systems are not model-bound. They are feature-bound.

A request that fetches 40 features from 5 stores can spend more time on network I/O than on inference. Capacity planning must include feature-store QPS and fanout:

```text
prediction_rps = 12,000
feature_groups_per_prediction = 5
online_feature_qps = 60,000 group reads/s
```

If each group read fans out internally to multiple partitions, the backend load is higher. Add cache hit rates:

```text
backend_qps = prediction_rps × feature_groups × (1 - cache_hit_rate)
```

At 90% hit rate:

```text
12,000 × 5 × 0.10 = 6,000 backend reads/s
```

At 50% hit rate:

```text
12,000 × 5 × 0.50 = 30,000 backend reads/s
```

A cache hit-rate regression can therefore create a 5× backend load increase with no traffic growth. Feature fetch capacity belongs in the inference plan.

---

## Cold Start and Warm Capacity

Model replicas have load time. Large models may take tens of seconds or minutes to load weights into memory. Capacity that is not warm is not immediately available.

If demand can spike by 5,000 RPS in one minute and a replica takes two minutes to become ready, reactive autoscaling cannot save the SLO. The capacity must already be warm or predicted early enough.

```text
warmup_time = 120s
scale_signal_lead_time must be > 120s
```

This changes scale-down policy. Ordinary web services may scale down aggressively. Model services often keep warm pools because the cost of cold-start latency is higher than the cost of idle capacity.

A capacity plan should state:

- minimum warm replicas,
- scale-up signal and threshold,
- expected warmup time,
- scale-down delay,
- cold-start user impact,
- whether scale-to-zero is allowed.

For latency-critical large models, scale-to-zero is usually a false economy.

---

## Batch Inference Sizing

Batch scoring is throughput planning. The question is: can the job finish before its deadline at acceptable cost?

Example:

```text
Users to score: 200M
Deadline: 4 hours
Required throughput: 200M / (4 × 3600) ≈ 13,900 predictions/s
```

If one worker scores 2,000 predictions/s safely:

```text
workers = 13,900 / 2,000 ≈ 7 workers
```

Add straggler and retry headroom; provision 10. Then estimate cost:

```text
10 workers × 4 hours × $3/hour = $120 per run
```

Batch inference often becomes I/O-bound. Reading features, writing predictions, and shuffling candidate sets can dominate model compute. Measure throughput by pipeline stage:

```text
read features → preprocess → inference → write outputs
```

The slowest stage sets throughput. If inference is 50,000/s but writes are 10,000/s, buying more GPUs does nothing.

---

## Training Cost Planning

Training cost is accelerator count times wall-clock time plus storage and orchestration overhead.

```text
training_cost = accelerator_count × hours × hourly_rate
              + CPU/memory overhead
              + storage/read costs
              + experiment multiplier
```

The experiment multiplier is what surprises teams. One training run may be cheap; hyperparameter search multiplies it.

```text
base run: 8 GPUs × 6h × $4/h = $192
50 trials with early stopping at 40% average length:
  50 × 0.4 × $192 = $3,840
weekly search: ≈ $200K/year
```

Cost planning should be attached to the training pipeline. Every run records estimated cost, actual cost, dataset size, accelerator type, utilization, and reason. Cost anomalies often reveal pipeline bugs: data doubled, cache missed, distributed training slowed, spot instances stopped being used, or hyperparameter search exploded.

---

## Training Throughput and I/O

Accelerator utilization during training is often limited by data I/O. If GPUs wait for batches, cost burns without learning.

Estimate data demand:

```text
batch_size = 1024 examples
example_size = 200 KB
steps_per_second = 20
data_rate = 1024 × 200KB × 20 ≈ 4 GB/s
```

If the storage path cannot deliver 4 GB/s sustained, the GPUs idle. Fixes include:

- sharding data into appropriately sized files,
- sequential formats for full scans,
- local NVMe caching,
- prefetching and parallel data loaders,
- co-locating compute with storage,
- avoiding per-example remote reads.

Training capacity is therefore not only GPU quota. It is GPU + storage bandwidth + CPU preprocessing + network.

---

## Distributed Training Scaling Efficiency

Adding GPUs does not linearly reduce training time. Communication grows.

```text
speedup_N = single_gpu_time / N_gpu_time
scaling_efficiency = speedup_N / N
```

If 8 GPUs give 6× speedup, efficiency is 75%. If 64 GPUs give 20× speedup, efficiency is 31%; cost per useful training step may be worse than a smaller job.

A capacity plan should measure throughput per dollar, not only time-to-train. Sometimes the right answer is fewer GPUs for longer because queue wait and communication overhead make the larger job wasteful. Sometimes the product deadline justifies the waste. Make the trade explicit.

---

## Multi-Tenant GPU Clusters

A shared ML cluster is a scheduling system. Without policy, one team can starve others.

Required controls:

| Control | Purpose |
|---|---|
| Quotas | Bound team spend and usage |
| Fair share | Allocate idle capacity without permanent monopolies |
| Priority classes | Let production retraining preempt experiments |
| Gang scheduling | Start distributed jobs all at once or not at all |
| Checkpointing | Make preemption safe |
| Idle detection | Kill jobs holding GPUs without progress |
| Budget alerts | Stop runaway searches |

Gang scheduling is crucial. A distributed job needing 8 GPUs cannot make progress with 7. Partial allocation can deadlock the cluster: jobs hold some GPUs while waiting for the rest. All-or-nothing allocation avoids this.

---

## Cost per Prediction

Serving cost should be reduced to cost per prediction or cost per 1,000 predictions.

```text
cost_per_prediction = hourly_instance_cost / predictions_per_hour
```

Example:

```text
GPU instance: $4/hour
Throughput: 1,000 predictions/s = 3.6M/hour
Cost: $4 / 3.6M = $0.0000011 per prediction
```

At 10% utilization:

```text
effective throughput: 360K/hour
Cost: $4 / 360K = $0.000011 per prediction
```

A 10× utilization drop creates a 10× unit-cost increase. This is why batching, consolidation, and right-sizing matter more for ML serving than for many ordinary services.

---

## CPU Versus GPU Crossover

GPU is not automatically cheaper or faster. The crossover depends on model size, traffic, latency budget, and achievable batching.

Use this comparison:

```text
CPU fleet cost at required p99 and RPS
vs
GPU fleet cost at required p99 and RPS, including warm idle capacity
```

Small models at low traffic often belong on CPU. A GPU at 5% utilization is usually worse than a few CPU nodes. Quantization, distillation, pruning, and compilation can shift the crossover by making CPU viable or reducing GPU size.

The hardware decision should be per model, not platform-wide ideology.

---

## Headroom Policy

ML services need explicit headroom for:

- burst traffic,
- model load/warmup time,
- rolling deployments,
- shadow/canary traffic,
- dependency degradation,
- AZ or node failure,
- larger-than-normal inputs,
- batch jobs overlapping online peaks.

A sample policy:

```text
Online inference:
  steady peak GPU utilization ≤ 65%
  queue wait p99 ≤ 10ms
  tolerate one replica loss per pool
  keep previous production model warm during rollout

Training cluster:
  reserve 20% for production retraining
  experimental jobs preemptible
  distributed jobs require gang scheduling
```

Headroom is a product feature. It is what turns a burst from an outage into a blip.

---

## Failure Modes

**CPU-based autoscaling for GPU inference** scales too late or never because CPU is not the bottleneck. Defense: scale on queue depth, queue wait, GPU utilization, memory, and timeout rate.

**Average-latency planning** misses p99 violations caused by batching, fanout, and queueing. Defense: size against p95/p99 and test burst traffic.

**Cold-start capacity illusion** counts replicas that are starting but not yet serving. Defense: warm pools and predictive scale-up with warmup-time awareness.

**Feature-store bottleneck** buys more model servers while feature fetch is saturated. Defense: include feature QPS, cache hit rate, and fanout in capacity math.

**GPU OOM under variance** tests average input size but production sends long or large inputs. Defense: memory sizing with worst-case input bounds and headroom.

**Training GPU starvation** pays for accelerators that wait on data loading. Defense: measure data throughput, prefetch, shard correctly, and cache locally.

**Hyperparameter cost explosion** multiplies a cheap base run into a large bill. Defense: budget per search, early stopping, trial caps, and cost logging.

**Cluster deadlock from partial allocation** gives distributed jobs some but not all GPUs. Defense: gang scheduling.

**Shadow traffic overload** doubles inference and feature load during rollout. Defense: sample shadow, isolate resources, and include rollout overhead in headroom.

---

## Decision Framework

For any ML workload, answer:

1. Is this online, async, batch, or training? What freshness or deadline is required?
2. What is peak arrival rate, and what percentile latency or completion deadline matters?
3. What is the bottleneck: model compute, memory, feature fetch, storage I/O, network, or scheduler?
4. What is safe per-replica throughput at target utilization, not benchmark maximum?
5. How much warm capacity is required given model load time?
6. What is cost per prediction or cost per training run at expected utilization?
7. What headroom is required for failure, deploys, canaries, and bursts?
8. Which metric triggers scale-up before the user-visible metric breaks?
9. What happens when capacity is exhausted — queue, shed, fallback, or fail closed?
10. How will estimates be validated under open-loop, burst-shaped load?

A plan that cannot answer these is not capacity planning; it is hoping the cloud bill and p99 are friendly.

---

## Key Takeaways

1. ML capacity planning is still request rate, service time, concurrency, utilization, memory, bandwidth, and queueing — but the bottleneck resource is often accelerator memory or feature I/O.
2. Choose the serving regime first; batch is cheaper than online when freshness allows it.
3. Online inference sizing must use p99 latency, queue wait, safe utilization, and warmup time, not average throughput.
4. Dynamic batching trades latency for utilization; measure effective batch size and tail queue wait.
5. Accelerator memory is a hard limit; model weights, activations, caches, and input variance determine safe batch size.
6. Feature fetch fanout can dominate inference and must be included in QPS and latency budgets.
7. Training cost is accelerator-hours multiplied by experiment count; hyperparameter search is often the real bill.
8. Training throughput often bottlenecks on data I/O, not GPU FLOPs.
9. Shared GPU clusters need quotas, fair share, priority, checkpointing, and gang scheduling.
10. Cost per prediction rises directly when utilization falls; right-size hardware and measure CPU/GPU crossover.

---

## References

1. [Capacity Planning and Back-of-the-Envelope Estimation](../01-foundations/10-capacity-planning.md)
2. [Model Serving](./03-model-serving.md)
3. [Training Pipelines](./05-training-pipelines.md)
4. [The Tail at Scale](https://research.google/pubs/pub40801/) — Dean & Barroso, 2013
5. [Clipper: A Low-Latency Online Prediction Serving System](https://www.usenix.org/conference/nsdi17/technical-sessions/presentation/crankshaw) — Crankshaw et al., NSDI 2017
6. [NVIDIA Triton Inference Server Documentation](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/)
7. [FinOps and Cost Engineering](../11-observability/06-finops-cost-engineering.md)
