# macOS sidebar-glass composer comparison

Before/after video and screenshots for the sidebar-only composer backdrop mitigation.

Recorded from the real Synara Electron 43.4.1 development renderer on macOS with an isolated data directory, a neutral demo project, and native blur radius 30. The renderer reported native material application succeeded. The comparison uses dark and light appearance, activity-rail hover, and new draft activation without submitting a prompt.

The source base is upstream `c35bec0ea3b69410b4170f87c00a00109489b8b7`; the patch is `9e9f268b1`. Before restores exactly the upstream composer CSS variables (blur 40px / fill 55% / stacked fill 27.5%) as temporary inline renderer overrides. After removes those overrides and uses the PR stylesheet (no CSS backdrop / fill 92% / stacked fill 80%). All other application behavior is the same. Captions and the cursor ring are temporary presentation annotations.

This is a renderer capture, not a WindowServer recording. Whole-window native flicker was not reproduced during the investigation, so these assets demonstrate the scoped CSS change and interaction behavior, not proof that the reported native flicker is eliminated. Live confirmation remains necessary.

The images and video are kept on this standalone assets branch, separate from application source. The branch can be deleted after the PR merges.
