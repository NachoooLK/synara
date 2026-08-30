# Pull request visual evidence

This branch stores review-only PNG evidence for pull requests opened from this fork.
The files are intentionally kept outside the implementation branches so they do not
inflate or otherwise modify the pull request diffs.

## Provenance

- PR 841: baseline `fa42cde9`, head `9e1ca9b0`; isolated baseline UI plus a focused fixture using the PR's `sortThreadsForSidebar` logic.
- PR 843: baseline `fa42cde9`, head `3de76d01`; real `ShortcutsDialog` component before and after.
- PR 844: head `e3dfb58e`; focused real-component detail supplementing the existing before/after screenshots.
- PR 845: head `7ed1c3ee`; matched focused fixtures using the real thread-folder store and grouping logic, plus the real removal dialog.
- PR 846: head `358efed5`; server-only policy contract and focused verification evidence. No UI behavior is claimed.
- PR 847: baseline `a76d20ba`, head `dc79353d`; real `CreateProjectDialog` component before and after.
- PR 850: baseline `a76d20ba`, head `b423072b`; exact PR fixtures passed through the real runtime projection and transcript work-row component.

Generated and visually checked on 2026-08-31.
