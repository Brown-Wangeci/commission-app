# Chapter 4 requirements (extracted from the approved Chapter 3-4 document)

Source: WangeciBrown_162831_Mr_KOuma_Ch3_Ch4.docx, Section 4.2.

This file is a verbatim extraction for traceability use. Do not edit the wording.


## Table 4.1: Functional Requirements

| ID | Requirement | Priority | Source or rationale | Verification |
|---|---|---|---|---|
| FR-01 | The system shall allow a client business or a sales agent to register an account and shall verify the registered mobile number before the account becomes active. | Mandatory | Authentication module | Demonstration |
| FR-02 | The system shall authenticate a registered user before granting access to any role-specific function. | Mandatory | Authentication module | Test |
| FR-03 | The system shall restrict each authenticated user to the functions permitted by the assigned role of client, agent or administrator. | Mandatory | Segregation of duties | Access-control test |
| FR-04 | The system shall allow a client to create a job specifying the task description, the work area, the deadline and the commission structure to be applied. | Mandatory | Objective iii | Demonstration |
| FR-05 | The system shall allow a client to define, for each job, the set of evidence fields an agent must complete, including the field type, whether the field is mandatory, and the expected value format. | Mandatory | Gap identified in Section 2.4 | Demonstration |
| FR-06 | The system shall allow a client to fund an escrow balance through an M-Pesa STK Push request initiated from the client interface. | Mandatory | Objective iii | Sandbox demonstration |
| FR-07 | The system shall lock the maximum liability of a job against the client escrow balance when the job is published, and shall refuse publication where the available balance is insufficient. | Mandatory | Problem statement, Section 1.2 | Test |
| FR-08 | The system shall allow an agent to browse open jobs and to accept a job before submitting evidence against it. | Mandatory | Evidence submission module | Demonstration |
| FR-09 | The system shall render the evidence capture form from the field configuration defined by the client for that job. | Mandatory | Gap identified in Section 2.4 | Demonstration |
| FR-10 | The system shall record the device location and the capture timestamp with every submission. | Mandatory | Feature set, Section 3.2.2 | Test |
| FR-11 | The system shall store a submission created without network connectivity on the device and transmit it automatically once connectivity is restored, without creating a duplicate record. | Mandatory | Scope, Section 1.5.1 | Demonstration with network disabled |
| FR-12 | The system shall validate each submission against the evidence configuration of its job and shall reject a submission that omits a mandatory field. | Mandatory | Evidence submission module | Test |
| FR-13 | The system shall compute a fraud probability score for every submission using the trained classifier. | Mandatory | Objective iii | Test |
| FR-14 | The system shall generate a feature attribution explanation for every score it computes and shall store that explanation with the submission. | Mandatory | Objective iii | Inspection of stored records |
| FR-15 | The system shall route each submission for automatic approval, for administrator review, or for rejection, according to the configured decision thresholds. | Mandatory | Model validation, Section 3.2.4 | Test across threshold bands |
| FR-16 | The system shall present to the administrator, for each submission held for review, the submitted evidence, the fraud probability and the explanation of the contributing factors. | Mandatory | Human oversight | Demonstration |
| FR-17 | The system shall require an administrator to record a decision and a supporting reason before a held submission leaves the review queue. | Mandatory | Accountability | Test |
| FR-18 | The system shall calculate the commission payable for an approved submission by applying the commission rules defined for its job. | Mandatory | Commission module, Section 3.6.5 | Test |
| FR-19 | The system shall release the calculated amount from the locked escrow balance and disburse it to the registered M-Pesa number of the agent. | Mandatory | Objective iii | Sandbox demonstration |
| FR-20 | The system shall return unspent escrow funds to the available balance of the client when a job is closed. | Mandatory | Commission and escrow module | Test |
| FR-21 | The system shall record each state change of a submission as an event, compute a cryptographic hash of that event, and anchor the hash to the blockchain network. | Mandatory | Objective iii | Test |
| FR-22 | The system shall allow a client, an agent or an administrator to retrieve the audit record of a submission and to verify the stored hash against the anchored hash. | Mandatory | Objective iii | Demonstration |
| FR-23 | The system shall notify an agent when a submission is approved, rejected or paid. | Mandatory | Problem statement, Section 1.2 | Demonstration |
| FR-24 | The system shall allow an agent to lodge an appeal against a rejected submission within a defined appeal period. | Desirable | Fairness to the affected party | Demonstration |

## Table 4.2: Non-Functional Requirements

| ID | Characteristic | Requirement | Rationale | Verification |
|---|---|---|---|---|
| NFR-01 | Performance efficiency | At least 95 per cent of application programming interface requests that do not depend on an external service shall complete within 2 seconds under a load of 100 concurrent users. | Agents submit over mobile data, where longer waits lead to abandoned submissions and repeated retries. | Automated load test |
| NFR-02 | Performance efficiency | The fraud classifier shall return a score and an explanation within 1 second for a single submission on the deployment hardware. | Scoring occurs within the synchronous submission path, so it must not dominate the budget set in NFR-01. | Measurement over the test set |
| NFR-03 | Reliability | The agent application shall permit evidence capture and local storage while the device has no network connection, and shall transmit stored submissions without duplication once connectivity returns. | Network coverage in the target operating areas is intermittent. | Demonstration with network disabled |
| NFR-04 | Reliability | A disbursement instruction shall be issued at most once for any approved submission, including where an external callback is delivered more than once. | Duplicate disbursement causes direct and unrecoverable financial loss, and repeated callback delivery is a known behaviour of the payment interface. | Test with repeated callbacks |
| NFR-05 | Security | User passwords shall be stored only as salted hashes produced by an adaptive hashing function, and shall not be written to logs or returned by any interface. | Protection of credentials as required under the Data Protection Act, 2019. | Code inspection and database check |
| NFR-06 | Security | Only a user holding the administrator role shall reach the review queue and the approval and rejection functions. | The party who benefits from a payment must not be able to authorise it. | Access-control test |
| NFR-07 | Functional correctness | All monetary values shall be stored and computed as integer Kenyan Shilling cents, and no monetary computation shall use a floating point type. | Floating point rounding produces the same class of unexplained discrepancy that the system exists to eliminate. | Code inspection and arithmetic test |
| NFR-08 | Model quality | The fraud classifier shall achieve an F1 score of at least 0.85 and a recall of at least 0.90 on the held-out test set. | Thresholds established in Section 3.2.4. Recall is weighted above precision because an undetected fraudulent payout cannot be recovered, whereas a false flag is corrected at review. | Evaluation on the test set |
| NFR-09 | Explainability | Every automated assessment shall be accompanied by a stored record of the feature contributions that produced it, retained for the lifetime of the submission. | An assessment that affects payment must be explainable to the party it affects. | Inspection of stored records |
| NFR-10 | Human oversight | A submission whose score falls between the configured decision thresholds shall not be approved or rejected without a recorded administrator decision. | The model advises and the administrator decides. No automated process should determine a person’s income without review. | Test across threshold bands |
| NFR-11 | Integrity | The hash anchored for an audit event shall be reproducible from the stored event payload at any later date. | The audit trail has no evidential value in a dispute if it cannot be independently recomputed. | Verification test |
| NFR-12 | Usability | The agent interface shall be operable on an Android device of 360 pixels screen width, and every interactive control shall present a touch target of at least 48 by 48 pixels. | Agents use low-cost handsets outdoors. The target size follows the Web Content Accessibility Guidelines, version 2.1. | Inspection on the target device |
| NFR-13 | Privacy | Personal data shall be collected only where a stated processing purpose requires it, and an agent’s payout number shall be masked in every interface except where an administrator is resolving a dispute or a failed payout. | Data minimisation as required under the Data Protection Act, 2019. | Inspection |
| NFR-14 | Maintainability | The automated test suite shall cover commission calculation, escrow state transitions and payout dispatch, and shall pass before any change is merged to the main branch. | These components hold and move funds, so an undetected regression has financial consequence. | Continuous integration report |

## Table 4.3: Data Requirements

| ID | Requirement | Priority | Source or rationale | Verification |
|---|---|---|---|---|
| DR-01 | The training dataset shall consist of synthetic submission records constructed to reflect the fraud patterns reported in the literature reviewed in Section 2.2. | Mandatory | Data acquisition, Section 3.2.1 | Inspection of generator and dataset |
| DR-02 | Each record in the dataset shall carry a binary label indicating whether the submission represents fraudulent behaviour. | Mandatory | Supervised learning design | Inspection |
| DR-03 | The dataset shall be partitioned into training, validation and test subsets in the ratio 70:15:15 using stratified sampling that preserves the class distribution within each subset. | Mandatory | Model training, Section 3.2.3 | Inspection of the split |
| DR-04 | Class imbalance shall be addressed using the Synthetic Minority Over-sampling Technique applied only to the training subset and only after partitioning, so that no record synthesised from a training case appears in the validation or test subsets. | Mandatory | Data preprocessing, Section 3.2.2 | Inspection of the pipeline |
| DR-05 | The feature set shall comprise the engineered behavioural features defined in Section 3.2.2 and shall exclude any attribute that directly identifies an individual agent. | Mandatory | Fairness and data minimisation | Inspection of the feature list |
| DR-06 | Evidence payloads and job evidence configurations shall be stored in a semi-structured format that permits a different field set for each job without a schema change. | Mandatory | FR-05, FR-09 | Schema inspection |
| DR-07 | Every submission record shall retain the capture timestamp, the device location, and the identifier of the job configuration against which it was validated. | Mandatory | FR-10, dispute resolution | Database inspection |
| DR-08 | All monetary values shall be stored as integers denominated in Kenyan Shilling cents. | Mandatory | NFR-07 | Schema inspection |
| DR-09 | Audit event records shall be immutable once written. A correction shall be recorded as a new event rather than as a modification of an existing record. | Mandatory | Objective iii | Test of update attempts |
| DR-10 | Administrator review decisions shall be retained as labelled records and shall form part of the training data used in subsequent retraining cycles. | Mandatory | Retraining loop, Section 2.5 | Inspection of retraining input |
| DR-11 | Personal data shall be retained only for the period required by the dispute and appeal processes, after which records shall be anonymised while preserving the aggregated data required for model retraining. | Mandatory | Data Protection Act, 2019 | Inspection of retention procedure |

## Table 4.4: Interface and Integration Requirements

| ID | Requirement | Priority | Source or rationale | Verification |
|---|---|---|---|---|
| IR-01 | The system shall integrate with the M-Pesa Daraja interface for customer-to-business collection through STK Push and for business-to-customer disbursement of commissions. | Mandatory | FR-06, FR-19 | Sandbox demonstration |
| IR-02 | The system shall expose a callback endpoint for payment results, shall verify the origin of each callback, and shall treat repeated delivery of the same result as a single event. | Mandatory | NFR-04 | Test with repeated callbacks |
| IR-03 | Where the payment service is unavailable or returns an error, the system shall retain the instruction in a queue, retry according to a bounded schedule, and raise the failure to an administrator once the retry limit is reached. | Mandatory | Reliability of payout | Fault injection test |
| IR-04 | The system shall submit audit event hashes to the Polygon network through a smart contract interface and shall record the returned transaction identifier against the event. | Mandatory | FR-21 | Test on the test network |
| IR-05 | Where the blockchain network is unavailable, the system shall queue the anchoring operation and shall not block the submission or payout pipeline. | Mandatory | Availability of core flow | Fault injection test |
| IR-06 | The application server shall communicate with the machine learning inference service through a defined request and response contract that carries the feature vector and returns the score and the attribution. | Mandatory | FR-13, FR-14 | Contract test |
| IR-07 | Where the inference service does not respond within the time defined in NFR-02, the submission shall be routed to administrator review rather than approved or rejected automatically. | Mandatory | NFR-10 | Fault injection test |
| IR-08 | The agent client shall be delivered as a progressive web application whose service worker caches the application shell and queues outbound submissions. | Mandatory | FR-11, NFR-03 | Demonstration |
| IR-09 | All communication between the client, the application server and external services shall use HTTPS. | Mandatory | NFR-05 | Inspection and network capture |
| IR-10 | The user interface shall satisfy the Web Content Accessibility Guidelines, version 2.1, at level AA for contrast ratio and target size. | Desirable | NFR-12 | Accessibility audit |
