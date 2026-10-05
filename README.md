# Server hot-path profiling evidence

Product change: `3e483820865bc3ad1cf759e590ab465b571ee247`, based on upstream `a83a6248b`.

The archive includes four raw Node CPU profiles, filesystem/SQLite counters, client observations, the fixture/probe/reproduction harness, a synthetic fixture database and the measured report. No production account data or production database was used in these captures. Fixture tokens are synthetic. Captures precede final stale-auth lifecycle edge-case fixes; the measured valid-auth streaming path is unchanged.

SHA-256 (`synara-hot-path-evidence.zip`): `d44e7c7407691112d1da4b0cb8ccba2441faaf3f92945a9f49b82e4e2d37e1ea`.

This orphan assets branch is kept separate from application source.
