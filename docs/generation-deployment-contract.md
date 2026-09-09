# Generation deployment contract

Rollbridge treats web authority, jobs-generation authority, durable transition state, and old-release draining as separate concerns.

A successful activation-lifecycle deployment starts and health-checks the candidate, waits for the old generation's retirement/quiescence acknowledgement, activates the candidate jobs generation, switches web authority, checkpoints `committed`, and returns. The acknowledged old generation then continues draining and stopping asynchronously; deployment completion does not wait for that later work.

Failed candidates never receive traffic. Recovery is exact-authority and journaled; no operator should edit durable state. A degraded incumbent keeps web authority while jobs remain explicitly degraded until a fresh generation commits.

Persistent guardians may retain old processes, but new release processes must use current lifecycle semantics. Lifecycle command failures must retain bounded stdout/stderr and stage metadata. Runtime content digest is authoritative; package versions are compatibility metadata rather than unique code identity.
