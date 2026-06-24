# Offline Evaluation and Metric Design

## TL;DR

Offline evaluation is the cheapest place to reject a bad model and the most dangerous place to believe a good-looking one. It measures behavior on a frozen approximation of the world, using labels and splits that may be biased, delayed, leaked, stale, or misaligned with the product objective. The central discipline is to treat evaluation as a measurement system, not a notebook cell: define the decision the metric supports, pin the dataset and split, separate primary metrics from guardrails, evaluate slices, quantify uncertainty, check calibration and thresholds, and never confuse offline improvement with production impact. Offline evaluation answers **"is this candidate worth exposing to live traffic?"** It does not answer **"will this improve the business?"** That final causal question belongs to online experiments.

---

## The Job of Offline Evaluation

Offline evaluation exists because live traffic is expensive and risky. Before a model reaches shadow, canary, or experiment, the team needs evidence that it is not obviously worse than the incumbent. Offline evaluation provides that first filter.

The filter has three jobs:

1. **Reject regressions cheaply** — do not spend production risk on candidates that lose on historical data.
2. **Compare model variants quickly** — choose among architectures, features, hyperparameters, and training windows.
3. **Prepare deployment decisions** — estimate threshold behavior, calibration, slice risk, and expected operating trade-offs.

The key word is *filter*. Offline evaluation is not proof. It is a necessary but insufficient gate. The offline dataset is historical, logged under old policies, labeled by imperfect processes, and often missing the outcomes the new model would have caused. A candidate can win offline and lose online because the metric measured the wrong objective, the split leaked, the logs were biased by the incumbent model, or the world changed.

The correct posture is skeptical: offline evaluation should be hard to fool, but never trusted as the final verdict.

---

## Evaluation Is a Measurement System

A trustworthy offline evaluation has the same structure as any measurement system:

```mermaid
flowchart LR
    Q["Decision question"] --> DATA["Pinned eval dataset"]
    DATA --> SPLIT["Split / holdout policy"]
    SPLIT --> METRIC["Metric computation"]
    METRIC --> SLICE["Slice analysis"]
    SLICE --> UNC["Uncertainty"]
    UNC --> GATE["Promotion gate"]
```

Each stage can invalidate the result. If the decision question is vague, the metric will optimize the wrong thing. If the dataset is mutable, the result cannot be reproduced. If the split leaks, the score is inflated. If slice analysis is missing, the average hides harm. If uncertainty is absent, noise looks like progress. If the gate is informal, teams cherry-pick.

A production evaluation report should therefore be a versioned artifact:

```yaml
candidate_model: fraud_classifier:v42
baseline_model: fraud_classifier:v41
evaluation_dataset: fraud_eval:2026-06-24.3
label: transaction_fraud:v6
split: time_holdout_2026_05
primary_metric: recall_at_0.5_percent_fpr
guardrails:
  - precision_at_current_review_capacity
  - false_positive_rate_by_country
  - p99_inference_latency
uncertainty: bootstrap_95_ci
result: blocked
reason: japan_slice_fpr_regression
```

This is the evaluation analogue of a deployment contract. It makes the decision reproducible and reviewable.

---

## Start With the Decision, Not the Metric

Metrics are easy to compute and hard to choose. The correct metric depends on the product decision the model supports.

A fraud model does not merely classify fraud. It decides whether to allow, review, or block transactions under a review-team capacity constraint. A recommender does not merely rank clicked items. It chooses a slate that should improve long-term satisfaction without collapsing diversity. A medical risk model does not merely maximize AUC. It prioritizes patients for scarce intervention capacity.

This means the metric should match the decision surface:

| Decision type | Better metric family | Why |
|---|---|---|
| Binary action under fixed threshold | Precision, recall, FPR/FNR at threshold | Measures actual operating point |
| Review queue with fixed capacity | Precision@K, recall@K, lift@K | Capacity is the constraint |
| Ranking list | NDCG, MAP, MRR, recall@K | Position matters |
| Probability used by downstream policy | Calibration, Brier score, log loss | Probability meaning matters |
| Rare-event detection | PR-AUC, recall at fixed FPR | ROC-AUC can hide poor precision |
| Regression with asymmetric costs | Quantile loss, weighted error | Over- and under-prediction differ |
| Recommendation slate | Offline rank metrics + diversity/coverage | Set quality matters |

The anti-pattern is choosing the metric because it is standard. AUC is standard; it may be irrelevant. If the business can review only 10,000 cases per day, the metric that matters is quality in the top 10,000, not average ranking over every case. If the model output is used as a calibrated risk estimate, ranking metrics are insufficient because the probability value itself is a contract.

---

## Accuracy Is Usually the Wrong Metric

Accuracy is seductive because it is simple. It is also wrong for many production ML systems.

In imbalanced domains, accuracy mostly measures the majority class. If 99.9% of transactions are legitimate, a model that predicts "legitimate" for everything is 99.9% accurate and useless. Fraud, abuse, churn, medical diagnosis, security, and incident detection are all dominated by rare positive classes where accuracy hides the event of interest.

Even balanced accuracy can hide cost asymmetry. A false positive in fraud may send a legitimate customer to review; a false negative may lose money. A false positive in content moderation may censor speech; a false negative may expose users to harm. These errors do not have equal cost. The evaluation metric should encode the trade-off explicitly, or at least report the trade-off curve so a human can choose.

Confusion matrices are useful because they force this accounting:

```text
                 Predicted positive   Predicted negative
Actual positive       TP                    FN
Actual negative       FP                    TN
```

From this, derive the quantities the product actually cares about: false positives per day, missed fraud dollars, review queue load, appeal volume, blocked-user rate, intervention capacity. Metrics become meaningful when they are translated into operational consequences.

---

## Thresholds Are Part of the Model

Many models emit scores, but products take actions. The threshold or policy mapping score to action is part of the decision system and must be evaluated with the model.

A model can improve AUC while becoming worse at the current threshold. A model can be better calibrated but shift score distribution so that the old threshold doubles the review queue. A model can improve recall by flooding humans with false positives. Therefore every evaluation should report both threshold-free metrics and operating-point metrics.

```text
Threshold-free:
  ROC-AUC, PR-AUC, log loss, NDCG

Operating-point:
  precision at threshold 0.92
  recall at 0.5% FPR
  review volume per day
  false positives per 10K users
  expected cost under policy_v9
```

For high-impact systems, evaluate a **policy curve**:

| Threshold | Review volume/day | Precision | Recall | Estimated cost |
|---|---:|---:|---:|---:|
| 0.70 | 80,000 | 0.08 | 0.92 | high ops cost |
| 0.85 | 25,000 | 0.21 | 0.78 | balanced |
| 0.95 | 4,000 | 0.61 | 0.41 | misses too much |

This curve is more useful than one headline metric because it shows the trade space. It also protects against threshold migration bugs during deployment: if `v42` has a different score distribution than `v41`, the old threshold may not mean the old action rate.

---

## Calibration: When the Number Must Mean Probability

A ranking model only needs ordering. A risk model often needs calibrated probabilities. If a fraud model outputs 0.8, downstream systems may interpret that as "80% fraud probability" and price review, blocking, or reserves accordingly. If the true rate among 0.8-scored examples is 30%, the model may rank well but mislead every policy that consumes it.

Calibration asks whether predicted probabilities match observed frequencies:

```text
Among examples scored 0.70-0.80, is the positive rate roughly 75%?
Among examples scored 0.90-1.00, is the positive rate roughly 95%?
```

Common metrics include Brier score, expected calibration error, calibration curves, and log loss. Calibration must be evaluated by slice because a model can be calibrated globally and miscalibrated for a country, device, tenant, or protected group.

Calibration also drifts when base rates change. A model trained when fraud prevalence was 1% may over- or under-estimate probabilities when fraud prevalence is 3%, even if ranking remains decent. This is why monitoring prediction distributions and delayed labels matters after deployment.

---

## Ranking Evaluation: Positions, Candidates, and Missing Counterfactuals

Ranking metrics evaluate ordered lists, not independent examples. NDCG, MRR, MAP, recall@K, hit rate, and precision@K all encode position: an item at rank 1 matters more than the same item at rank 20.

The hidden issue is candidate availability. Offline ranking evaluation typically uses logged impressions or sampled negatives. That means the evaluation only knows about items the previous system retrieved or showed. A new retrieval model may find excellent candidates the old system never logged; offline evaluation may not credit it. Conversely, sampled negatives may be too easy, inflating metrics.

For recommenders and search systems, a serious offline report should state:

1. candidate source used for evaluation,
2. negative sampling strategy,
3. whether exposure and position bias are corrected,
4. whether metrics are computed per user/query then averaged,
5. coverage and diversity metrics, not only relevance.

A ranking metric without candidate-set context is incomplete. If the candidate generator changed, ranking evaluation over the old candidate set answers the wrong question.

---

## Leakage: The Evaluation That Certifies a Broken Model

Leakage happens when evaluation examples contain information that would not be available at prediction time. It is worse than ordinary data bugs because it makes the model look better.

Common leakage sources:

- random splits for time-dependent problems,
- joining latest feature values instead of point-in-time values,
- using post-action fields as features,
- duplicates across train and test,
- same user or entity appearing in both train and test when generalization to new entities matters,
- labels or label proxies included as features,
- preprocessing fit on the full dataset before splitting.

A good evaluation pipeline runs leakage checks automatically:

```text
- no feature availability_time > prediction_time
- no entity overlap for entity-disjoint split
- no duplicate content hashes across train/test
- no suspicious single-feature AUC near 1.0
- preprocessing fit only on train split
- label columns excluded from feature registry
```

The suspicious-feature check is crude but useful: if one feature alone makes the model nearly perfect in a hard domain, assume leakage until proven otherwise. Real-world prediction is rarely that easy.

---

## Slice Evaluation: Averages Lie

Aggregate metrics hide regressions. A candidate can improve overall AUC while harming new users, a small country, a protected class, a large tenant, or high-value transactions. If that slice is important, the aggregate is not a defense.

Slices should be pre-declared, not discovered only after a metric looks good. Common slices:

- geography and language,
- device and platform,
- new vs returning users,
- traffic source,
- tenant or merchant,
- item/content category,
- amount or risk band,
- protected or regulated groups where legally and ethically appropriate.

The challenge is multiple comparisons. If you inspect hundreds of slices, some will regress by chance. The solution is not to avoid slices; it is to separate **guardrail slices** from **exploratory slices**. Guardrail slices are pre-registered and can block promotion. Exploratory slices generate hypotheses and require confirmation.

A useful report format:

| Slice | Baseline metric | Candidate metric | Delta | CI | Gate |
|---|---:|---:|---:|---:|---|
| all traffic | 0.812 | 0.821 | +0.009 | [+0.005,+0.013] | pass |
| new users | 0.744 | 0.731 | -0.013 | [-0.022,-0.004] | fail |
| JP | 0.801 | 0.797 | -0.004 | [-0.009,+0.001] | watch |

The point is to make harm visible before deployment, when fixing it is cheapest.

---

## Uncertainty: Do Not Ship Noise

Offline metrics are estimates. A reported AUC of 0.812 is not a fact about the universe; it is an estimate on a finite sample. If the candidate scores 0.813, the difference may be noise.

Evaluation should report confidence intervals or uncertainty estimates. Bootstrap resampling is often sufficient: resample users or entities, recompute the metric, and report the distribution of deltas. The resampling unit matters. For recommender systems, resample users, not rows, because interactions from one user are correlated. For marketplace experiments, resample markets or clusters when those are the independent units.

```text
candidate - baseline PR-AUC = +0.004
95% bootstrap CI = [-0.001, +0.009]
verdict = inconclusive, not pass
```

The promotion gate should evaluate the delta and its uncertainty, not only the point estimate. A small noisy win is not a win. This discipline prevents model teams from shipping random variation as progress.

---

## Baselines: Beat the Right Thing

Every evaluation needs baselines. The strongest baseline is the current production model evaluated on the same dataset. Without it, the team cannot distinguish absolute quality from improvement.

Useful baselines include:

1. **Current production model** — the real incumbent.
2. **Simple heuristic** — catches overengineered models that barely beat rules.
3. **Previous training run with same code** — estimates training variance.
4. **Ablation models** — measure whether a feature group actually helps.
5. **Oracle-ish upper bound** where available — estimates room for improvement.

The heuristic baseline is underrated. If a complex ML system barely beats "rank by popularity" or "review transactions above amount threshold," it may not justify its operational cost. ML should earn complexity.

---

## Cost-Sensitive Evaluation

Many production decisions have asymmetric and nonuniform costs. A false positive on a $5 transaction is not the same as a false positive on a $5,000 transaction. A false negative for severe abuse is not the same as a false negative for mild spam.

Cost-sensitive evaluation translates confusion-matrix cells into business impact:

```text
expected_cost = FP_count × cost_FP
              + FN_count × cost_FN
              + review_count × cost_review
              + latency_cost
              + fairness_or_policy_penalties
```

The exact numbers may be uncertain, but writing them down forces the trade-off into the open. It also reveals when a metric is misaligned. Optimizing recall without review cost may choose a model the operations team cannot run. Optimizing revenue without complaint cost may choose a model users hate.

Cost models should be versioned because product policy changes. A model approved under `cost_policy_v3` may not be approved under `v4`.

---

## Offline-to-Online Gap

Offline metrics fail to predict online impact for structural reasons:

1. **Logged-policy bias** — the evaluation data was generated by the old model.
2. **Feedback loops** — the new model changes future data.
3. **Proxy mismatch** — offline label is not the real product goal.
4. **Distribution shift** — production traffic has moved.
5. **Interference** — users/items/markets affect each other.
6. **Implementation skew** — serving computes features differently.

This is why offline evaluation should gate exposure, not replace online experiments. The handoff should be explicit:

```text
Offline pass → shadow for runtime safety → canary for operational guardrails → A/B for causal impact
```

A team that ships directly from offline metrics is assuming away the entire reason production ML is hard.

---

## Failure Modes

**Metric mismatch** optimizes what is easy to label rather than what matters: clicks instead of satisfaction, approvals instead of repayment, reports instead of true abuse. Defense: metric hierarchy with primary, guardrail, and diagnostic metrics tied to the product decision.

**AUC worship** celebrates threshold-free ranking improvement while the operating threshold, review capacity, or calibrated probability behavior worsens. Defense: report operating-point and policy metrics.

**Leaky evaluation** certifies a broken model because future information entered features, splits, or preprocessing. Defense: point-in-time joins, honest splits, duplicate checks, and suspicious-feature audits.

**Average hides harm** ships a model that improves aggregate quality while degrading an important slice. Defense: pre-registered slice guardrails and uncertainty-aware deltas.

**Noise shipped as progress** promotes tiny metric changes without confidence intervals or training-variance checks. Defense: bootstrap CIs, repeated seeds, and minimum practical effect thresholds.

**Old-candidate-set evaluation** penalizes a new retrieval system because evaluation only includes items the old system found. Defense: evaluate retrieval and ranking separately and state candidate-set construction.

**Offline-online surprise** happens when a model wins offline and loses online because logs were biased or the proxy metric was wrong. Defense: treat offline as a filter and require progressive rollout plus experiment for impact.

---

## Decision Framework

Before trusting an offline result, ask:

1. What production decision does this metric support?
2. Is the evaluation dataset immutable, versioned, and point-in-time correct?
3. Does the split match the generalization question?
4. Are the labels mature, and is the label definition versioned?
5. Are threshold, calibration, capacity, and cost evaluated, or only ranking?
6. Does the candidate beat the current production model on the same data?
7. Are important slices guarded?
8. Is the delta larger than uncertainty and training variance?
9. Could logged-policy bias or missing counterfactuals invalidate the conclusion?
10. What live rollout stage will verify the remaining risk?

Offline evaluation that answers these well is a trustworthy gate. Offline evaluation that cannot answer them is a chart, not evidence.

---

## Key Takeaways

1. Offline evaluation is a cheap rejection filter, not proof of production impact.
2. Treat evaluation as a measurement system with pinned data, declared metrics, slice analysis, uncertainty, and a gate.
3. Start with the decision the model supports; choose metrics that reflect the operating constraint.
4. Accuracy is often useless for imbalanced or asymmetric-cost systems.
5. Thresholds and policies are part of the model's behavior and must be evaluated together with the artifact.
6. Calibration matters whenever downstream systems interpret scores as probabilities.
7. Ranking metrics require candidate-set and exposure context; otherwise they answer an incomplete question.
8. Leakage makes bad models look excellent; point-in-time correctness and honest splits are non-negotiable.
9. Averages hide harmed slices; pre-register guardrail slices and report uncertainty.
10. Offline wins must pass through shadow, canary, and experiments before being treated as production wins.

---

## References

1. [Rules of Machine Learning: Best Practices for ML Engineering](https://developers.google.com/machine-learning/guides/rules-of-ml) — Zinkevich
2. [Hidden Technical Debt in Machine Learning Systems](https://proceedings.neurips.cc/paper_files/paper/2015/file/86df7dcfd896fcaf2674f757a2463eba-Paper.pdf) — Sculley et al., 2015
3. [The ML Test Score: A Rubric for ML Production Readiness](https://research.google/pubs/pub46555/) — Breck et al., 2017
4. [Data Validation for Machine Learning](https://mlsys.org/Conferences/2019/doc/2019/167.pdf) — Breck et al., 2019
5. [Trustworthy Online Controlled Experiments](https://www.cambridge.org/core/books/trustworthy-online-controlled-experiments/6A3B263E7114E81B95669A95B219C1D8) — Kohavi, Tang & Xu, 2020
6. [Offline Evaluation for Recommender Systems](https://dl.acm.org/doi/10.1145/1864708.1864721) — recommender evaluation and bias context
7. [Model Evaluation, Model Selection, and Algorithm Selection in Machine Learning](https://arxiv.org/abs/1811.12808) — Raschka, 2018
