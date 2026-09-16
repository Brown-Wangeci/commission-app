# Data Dictionary

This document defines the fraud label, the raw event schema, and the T0/T7
feature sets for the activation-fraud model. All data described here is
synthetic, produced by `src/generator/`. Nothing in this file is an empirical
claim about real agents, customers, or fraud rates; parameter values that
would encode such claims live in `config/generator.yaml`, where each one
carries its source.

## 1. Label definition

**`is_fraudulent`**: an activation is fraudulent if the customer account was
created without the genuine intent or informed consent of the named customer,
or if the agent manipulated the activation record in order to trigger a
commission that the underlying work does not justify.

In this synthetic dataset the label is assigned by the generator according to
that definition, through the four typologies described in section 6: an
activation is labelled fraudulent exactly when it was produced by one of
those typologies, and legitimate otherwise. The label is a hidden generator
variable. It is held in a separate object from the observable event log and
is never visible to feature code.

**Out of scope.** A genuine activation that turns out to be commercially
disappointing is *not* fraud. A real, consenting customer who signs up and
then never uses the service, tops up nothing, and lapses within the week is a
legitimate activation and is labelled as such. This classifier decides
whether an activation was obtained honestly, not whether it was profitable.
Low-value-but-genuine activations are deliberately generated in volume (see
section 5) precisely so that the model cannot use "no downstream activity" as
a proxy for fraud.

## 2. Raw event schema

These are the only fields feature code may read. Section 2e lists the
generator's internal variables, which feature code cannot access: the
observable log refuses to be constructed if any of them is present.

### 2a. Activation submission event (one row per activation)

| Field | Type | Description |
|---|---|---|
| `activation_id` | string | Unique identifier for the activation. |
| `agent_id` | string | Identifier of the submitting agent. |
| `job_id` | string | Identifier of the assignment this activation fulfills. |
| `client_business_id` | string | Client business the customer is being signed up for. |
| `job_assigned_timestamp` | datetime | When the job was assigned to the agent. |
| `job_accepted_timestamp` | datetime | When the agent accepted the job. |
| `timestamp_submitted` | datetime | Server-side timestamp when the activation was submitted. |
| `device_id` | string | Hashed device fingerprint of the submitting device. |
| `device_os` | string | Device operating system. |
| `app_version` | string | App version at submission. |
| `ip_address_region` | string | Coarse region inferred from the submission IP, recorded as `ip_geolocation_region`. |
| `network_type` | string | `cellular` or `wifi`. |
| `submission_gps_lat` | float | Latitude reported by the device at submission. |
| `submission_gps_lon` | float | Longitude reported by the device at submission. |
| `customer_msisdn_hash` | string | Hashed customer phone number. |
| `sim_registration_date` | date | Date the SIM being activated was registered with the telco. |
| `activation_method` | string | `qr_scan` or `manual_entry`. |
| `proof_of_activation_hash` | string or null | Hash of the proof artifact. Only presence or absence is ever read, never content. |
| `escrow_amount` | float | Amount placed in escrow for this job. |
| `commission_rate` | float | Commission rate applicable to this job. |

### 2b. Agent register (one row per agent)

| Field | Type | Description |
|---|---|---|
| `agent_id` | string | Identifier of the agent. |
| `agent_registration_date` | date | When the agent joined the platform. |
| `agent_home_lat` | float | Latitude of the agent's registered base location. |
| `agent_home_lon` | float | Longitude of the agent's registered base location. |

### 2c. Payout cycle calendar (one row per cycle)

The payout schedule is published by the platform, so it is observable to
everyone including the model.

| Field | Type | Description |
|---|---|---|
| `cycle_id` | integer | Sequential identifier of the payout cycle. |
| `cycle_start_date` | date | First day of the cycle. |
| `cutoff_timestamp` | datetime | Moment the cycle closes and escrow is released. |

### 2d. Downstream customer activity log (days 0 to 7 after activation)

| Field | Type | Description |
|---|---|---|
| `activation_id` | string | Foreign key to the submission event. |
| `event_day` | integer | Day offset from activation, 0 to 7. |
| `customer_active_flag` | boolean | Whether the customer generated any usage event that day. |
| `transaction_count` | integer | Customer transactions that day. |
| `topup_amount` | float | Value topped up by the customer that day. |
| `usage_minutes` | float | Service usage minutes that day. |
| `support_contact_flag` | boolean | Whether the customer contacted support that day. |
| `complaint_or_refund_flag` | boolean | Whether a complaint or refund request was filed that day. |
| `sim_active_flag` | boolean | Whether the account was still active at the end of that day. |

### 2e. Generator-internal variables (never observable)

| Field | Description |
|---|---|
| `is_fraudulent` | The label. |
| `fraud_typology` | Which typology generated the activation. |
| `mode` | The behavioural profile used to generate the record. |
| `careful` | Whether a fraudulent activation was deliberately disguised. |
| `honesty_type` | The agent's honesty type: honest, opportunistic or systematic. |
| `ring_id` | Grouping of colluding agents and devices. |
| `episode_id` | The agent-day fraud episode a record belongs to. |
| `engagement` | Latent customer engagement driving downstream activity. |
| `is_ambiguous` | Whether the record sits in genuinely ambiguous territory. |
| `flag_*` | The situational flags used to build lookalike cases. |

Separation is enforced in code, not by convention. `src/generator/schema.py`
defines `ObservableLog` and `InternalState` as two distinct objects;
`build_features` accepts only an `ObservableLog` and raises if handed
anything else, and constructing an `ObservableLog` containing any field from
this table raises `LeakageError`.

## 3. T0 features (available the moment an activation is submitted)

| Feature | Formula | Raw fields read |
|---|---|---|
| `submission_latency_seconds` | Seconds from job assignment to submission. | `job_assigned_timestamp`, `timestamp_submitted` |
| `job_acceptance_latency_seconds` | Seconds from job assignment to acceptance. | `job_assigned_timestamp`, `job_accepted_timestamp` |
| `acceptance_to_submission_seconds` | Seconds from acceptance to submission, the time actually spent on the job. | `job_accepted_timestamp`, `timestamp_submitted` |
| `distance_from_agent_home_km` | Distance between submission GPS and the agent's registered base. | `submission_gps_lat`, `submission_gps_lon`, `agent_home_lat`, `agent_home_lon` |
| `agent_tenure_days` | Days between agent registration and this submission. | `agent_registration_date`, `timestamp_submitted` |
| `sim_age_at_activation_days` | Days between SIM registration and this submission. | `sim_registration_date`, `timestamp_submitted` |
| `agent_activation_velocity_1h` | Submissions by this agent in the trailing hour, including the current one. | `agent_id`, `timestamp_submitted` |
| `agent_activation_velocity_24h` | Submissions by this agent in the trailing 24 hours, including the current one. | `agent_id`, `timestamp_submitted` |
| `device_activations_7d` | Submissions from this device by anyone in the trailing 7 days, including the current one. | `device_id`, `timestamp_submitted` |
| `device_shared_agent_count_30d` | Distinct agents who submitted from this device in the trailing 30 days. | `device_id`, `agent_id`, `timestamp_submitted` |
| `distinct_devices_used_30d` | Distinct devices this agent submitted from in the trailing 30 days. | `agent_id`, `device_id`, `timestamp_submitted` |
| `customer_msisdn_prior_activation_count` | Earlier activations on this MSISDN by anyone in the trailing 90 days. | `customer_msisdn_hash`, `timestamp_submitted` |
| `days_to_payout_cutoff` | Days from submission to the next payout cutoff. | `timestamp_submitted`, `cutoff_timestamp` |
| `ip_location_mismatch_flag` | 1 if the IP region differs from the region nearest the submission GPS. | `ip_geolocation_region`, `submission_gps_lat`, `submission_gps_lon` |
| `activation_method_is_manual_entry` | 1 if the activation was keyed in rather than scanned. | `activation_method` |
| `proof_of_activation_missing_flag` | 1 if no proof artifact was attached. | `proof_of_activation_hash` |
| `submission_hour_of_day` | Hour of day of submission, with minutes as a fraction. | `timestamp_submitted` |
| `network_type_is_cellular` | 1 if submitted over cellular rather than wifi. | `network_type` |

## 4. T7 features (available seven days after submission)

| Feature | Formula | Raw fields read |
|---|---|---|
| `customer_active_days_7d` | Count of days 0 to 7 on which the customer was active. | `customer_active_flag` |
| `days_to_first_customer_activity` | Earliest day with activity; set to 8 if the customer was never active. | `event_day`, `customer_active_flag` |
| `transaction_count_7d` | Total transactions over the window. | `transaction_count` |
| `topup_amount_total_7d` | Total topup value over the window. | `topup_amount` |
| `usage_minutes_total_7d` | Total usage minutes over the window. | `usage_minutes` |
| `support_contact_count_7d` | Number of days on which the customer contacted support. | `support_contact_flag` |
| `complaint_or_refund_flag_7d` | 1 if a complaint or refund was filed on any day. | `complaint_or_refund_flag` |
| `sim_active_at_day7` | Whether the account was still active on day 7. | `sim_active_flag`, `event_day` |
| `activity_dropoff_flag` | 1 if the customer was active on day 0 or 1 and on no day from 2 to 7. | `customer_active_flag`, `event_day` |

**How the downstream channels relate.** In the generator, a customer's latent
engagement decides which days they are active. How much they transact, top
up and use on an active day is drawn per channel, and each channel has its
own per-customer propensity and its own day-to-day noise. It also follows
engagement only partially. The three propensities share one common component,
so the channels are positively correlated (a customer with more money tends
to do more of everything) but not collinear: a heavy spender can transact
rarely, and a daily user can spend little. None of these channel parameters
differs between the classes (`downstream_channels` in `config/generator.yaml`).
The realised pairwise correlations are written to
`outputs/t7_correlation_pearson.csv` and `outputs/t7_correlation_spearman.csv`.

## 5. Leak-safety statement

No feature reads the label or any internal variable from section 2e. The
generator sets the label first and then draws observable field values from
the behavioural distribution that the label implies; features read only those
observable values, so information flows one way. Two further protections
apply to every feature below: the observable log physically cannot carry an
internal column, and every T0 feature is computed from the current row plus
strictly earlier rows, which a regression test verifies by recomputing T0 on
a truncated log and requiring identical values.

- `submission_latency_seconds`: two submission-event timestamps; label not read.
- `job_acceptance_latency_seconds`: two submission-event timestamps; label not read.
- `acceptance_to_submission_seconds`: two submission-event timestamps; label not read.
- `distance_from_agent_home_km`: submission GPS and the agent register; label not read.
- `agent_tenure_days`: agent register and submission timestamp; label not read.
- `sim_age_at_activation_days`: SIM registration date and submission timestamp; label not read.
- `agent_activation_velocity_1h`: this agent's earlier submission timestamps; label not read.
- `agent_activation_velocity_24h`: this agent's earlier submission timestamps; label not read.
- `device_activations_7d`: earlier submissions on the same device; label not read.
- `device_shared_agent_count_30d`: agent identifiers on earlier submissions from the same device; label not read.
- `distinct_devices_used_30d`: device identifiers on this agent's earlier submissions; label not read.
- `customer_msisdn_prior_activation_count`: earlier submissions keyed by hashed MSISDN; label not read.
- `days_to_payout_cutoff`: submission timestamp against the published payout calendar; label not read.
- `ip_location_mismatch_flag`: IP region and GPS on the same event; label not read.
- `activation_method_is_manual_entry`: one categorical submission field; label not read.
- `proof_of_activation_missing_flag`: presence or absence of a hash, never its content; label not read.
- `submission_hour_of_day`: the submission timestamp; label not read.
- `network_type_is_cellular`: one categorical submission field; label not read.
- `customer_active_days_7d`: downstream activity flags; label not read.
- `days_to_first_customer_activity`: downstream activity flags and day offsets; label not read.
- `transaction_count_7d`: downstream transaction counts; label not read.
- `topup_amount_total_7d`: downstream topup amounts; label not read.
- `usage_minutes_total_7d`: downstream usage minutes; label not read.
- `support_contact_count_7d`: downstream support-contact flags; label not read.
- `complaint_or_refund_flag_7d`: downstream complaint and refund flags; label not read.
- `sim_active_at_day7`: one downstream flag on day 7; label not read.
- `activity_dropoff_flag`: downstream activity flags across days; label not read.

## 6. Fraud typologies

Fraud is committed by agents, not by rows. Agents have an honesty type:
honest agents never defraud, opportunistic agents defraud occasionally and
more often as a payout cutoff approaches, and systematic agents work at high
volume and often belong to a ring. A dishonest agent enters a fraud *episode*
on a particular day; only some of that day's activations are fraudulent, so
episodes mix real and fabricated work. A share of fraudulent activations in
every typology are committed *carefully*: the agent deliberately imitates
ordinary behaviour on some dimensions, which makes those records genuinely
hard to catch.

### Ghost activations
The agent submits an activation for a customer who does not exist or who
never consented, collecting a commission without delivering a real customer.
Expected signature: almost no downstream activity, the account often going
inactive before day 7, submissions keyed in by hand rather than scanned
because there is no customer present, a missing proof artifact more often
than usual, very little time between accepting the job and submitting it
since no meeting takes place, and a modest chance that the named person
eventually discovers the account and complains.

### SIM farming
An agent or a coordinated ring enrols many freshly registered SIMs in bulk,
from a small number of devices and locations, to collect per-activation
commissions on volume. Expected signature: submissions clustered into tight
bursts, one device used by several agents, a small device pool relative to
activation volume, SIMs registered within a day or two of activation, short
distances from the agent's base, more IP-to-GPS region mismatches, more
reuse of MSISDNs already seen on the platform, and a bias toward wifi over
cellular because the work is done from a fixed base.

### Agent-customer collusion
A real, identifiable customer agrees to be signed up, usually for a share of
the commission, without intending to use the service. Expected signature:
ordinary-looking submission behaviour, because the customer is real and the
meeting genuinely happened, combined with downstream activity that starts
promptly and then falls away sharply within the first days. Complaints are
rare but not absent, since collusive arrangements sometimes sour.

### Payout-cycle gaming
The agent times work around the escrow payout calendar rather than
fabricating customers outright, for example holding accepted jobs and
releasing them together just before a cutoff so they clear in the current
cycle. Expected signature: submissions clustered in the hours before a payout
cutoff, long delays between a job being assigned and accepted followed by a
burst of submissions, and activity concentrated in the days immediately
before a cutoff. Downstream customer behaviour is often partly genuine, which
makes this the typology least visible in the T7 features. Both timing tells
have honest counterparts (section 7): a careful gaming activation submits on
the ordinary time-of-day profile instead of before the cutoff, and long
acceptance delays also arise from agents who work in the evenings or through a
multi-day event backlog.

## 7. Legitimate lookalikes

Every signature in section 6 has an honest counterpart, drawn from an
overlapping distribution. Without these, individual features would separate
the classes cleanly and the model would learn an artefact of the generator.

| Fraud signature | Legitimate counterpart |
|---|---|
| Near-zero downstream activity (ghost) | Genuine but dormant customers, who sign up willingly and then never use the service. This is the largest lookalike population in the dataset. |
| Tight submission bursts (SIM farming) | Client campaign days and local market days, when honest agents legitimately sign up a queue of walk-ups. |
| One device used by several agents (SIM farming) | Honest teams running a shared enrolment device at a campus or hostel drive. |
| SIM registered the same day (SIM farming) | Customers who buy and register a SIM at the moment of signup. |
| Submissions from a single location (ghost, SIM farming) | Honest agents who work one fixed site rather than travelling. |
| Very short time from acceptance to submission (ghost, SIM farming) | Honest agents working through a queue at a drive, where each signup genuinely takes minutes. |
| Clustering before a payout cutoff (payout gaming) | Honest agents rushing to finish work before the same deadline. |
| Long delay between a job being assigned and accepted (payout gaming) | Agents who do not open the app when the job arrives and accept it hours later, for example someone working activations around another job in the evenings. |
| Long delay between accepting a job and submitting it (payout gaming) | Agents who accept a batch of jobs at the start of a multi-day event and work through them on following days. |
| Early activity that stops (collusion) | Genuine customers who try the service once and lapse. |
| Repeat activation on a known MSISDN (SIM farming) | Genuine reactivations of a number already seen on the platform. |

A record is counted as ambiguous when a legitimate activation carries at
least three of these situations at once, or when a fraudulent activation was
committed carefully. The generator targets roughly ten percent of all records
in this territory; `notebooks/01_generation_checks.ipynb` reports the
realised counts.
