---
name: debug-simulator-ux
description: Reproduce, inspect, diagnose, and verify any visible or interactive iOS Simulator UX issue using sim-cli and the smallest useful evidence bundle. Use for layout and safe-area bugs, keyboard and focus behavior, scrolling and anchoring, gestures and hit targets, navigation and presentation, animation smoothness or jank, loading and transient states, accessibility, visual regressions, and before/after UX comparisons.
---

# Debug Simulator UX

Use simulator evidence to answer what happened, when it happened, and which layer likely caused it. Select evidence for the issue instead of recording video by default.

## Ground the run

1. Read the target repository's agent instructions and discover its supported build and launch command.
2. Claim an explicit simulator. Never rely on `booted` when multiple devices are running, and never reuse a simulator owned by another session.
3. Preserve the user's app state unless resetting it is necessary to reproduce the issue.
4. Use `sim-cli --help`, `sim-cli help <command>`, or `sim-cli agent-context` to discover the installed command surface instead of guessing flags.
5. Launch the current build only when needed. Reinstalling can destroy the state under investigation.

## Choose the evidence

Read [references/ux-rubric.md](references/ux-rubric.md) for the review criteria and evidence map.

- Use screenshots and accessibility geometry for static layout, clipping, hierarchy, and hit-target issues.
- Use accessibility actions and explicit state assertions for focus, navigation, controls, and gestures.
- Use a short video for motion, timing, transient-state, scrolling, keyboard, or presentation issues.
- Use app and simulator logs to explain causes, state transitions, failures, and timing.
- Use crash reports when the app exits or becomes unresponsive.

Logs can prove state correctness. They cannot, by themselves, prove that motion looked smooth.

## Reproduce minimally

1. Reduce the issue to the shortest deterministic interaction.
2. Capture the initial screenshot and accessibility tree.
3. Prefer accessibility identifiers, labels, and `sim-cli wait` over raw coordinates and arbitrary sleeps.
4. Perform one meaningful interaction at a time.
5. Capture the final screenshot, accessibility tree, and relevant log window.
6. Repeat once when the issue may be intermittent. Record whether reproduction is deterministic.

Do not implement a fix when the user only asked for diagnosis. If a fix is requested, preserve the same reproduction so the before/after comparison remains valid.

## Capture motion

Stage the app before recording. Keep a take focused on one interaction and normally between two and six seconds.

1. Verify required simulator state such as orientation, appearance, locale, and software-keyboard visibility.
2. Start `sim-cli record-video` with an explicit output path outside the source tree unless the user requested an artifact there.
3. Run start, interaction, settling capture, and stop in one orchestration block. Do not inspect frames or reason at length while recording.
4. Capture both directions when asymmetry matters, such as presenting and dismissing or keyboard opening and closing.
5. Repeat the same motion after a fix with the same device, state, and interaction.
6. Validate that the file is playable and contains the intended transition before reporting it.

Use `scripts/analyze-video.sh <video> [output-directory]` when `ffmpeg` and `ffprobe` are available. Inspect its first frame, last frame, and contact sheets visually. Treat encoded frame timestamps as supporting evidence only: simulator recording is variable-frame-rate, and static-frame gaps are not proof of UI jank.

## Correlate and diagnose

Align the interaction, visible symptom, accessibility geometry, and logs by time. Separate:

- the symptom the user sees,
- the first frame or state where behavior diverges,
- the invariant or relationship that should have held,
- the likely owning layer,
- the smallest next probe that would confirm the cause.

For motion, compare relationships frame by frame rather than only endpoints. Look for monotonic movement, synchronized edges, reversals, late snaps, relayout, stalls, and clean settling.

## Verify a fix

Re-run the exact reproduction. A green build or correct final screenshot is insufficient for a time-dependent issue. Compare before and after using the same evidence type, and check that nearby behavior such as interactive dismissal, scrolled-away state, rotation, or dynamic content did not regress when relevant.

## Report

Lead with a verdict: reproduced, not reproduced, fixed, regressed, or inconclusive. Include:

- the minimal reproduction,
- expected versus observed behavior,
- paths to screenshots, videos, and derived artifacts,
- the decisive accessibility geometry and log lines,
- the likely cause or confirmed fix,
- simulator-only limitations and remaining device verification.

Do not call motion smooth solely because no error log fired. Do not call a variable-frame-rate recording janky solely because encoded frame timestamps contain gaps.
