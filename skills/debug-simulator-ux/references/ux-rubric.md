# Simulator UX Evidence and Review Rubric

## Evidence map

| Issue | Primary evidence | Supporting evidence |
| --- | --- | --- |
| Layout, clipping, safe area | Screenshot | AX frames, orientation, device size |
| Focus, controls, hit targets | AX tree and actions | Screenshot, state logs |
| Keyboard and input | Short video | AX frames before/after, focus and inset logs |
| Scroll and anchoring | Short video | Content offset, viewport, ownership logs |
| Navigation and presentation | Video or step screenshots | AX hierarchy, routing logs |
| Animation and jank | Short video and contact sheet | Display timing, signposts, state logs |
| Loading and transient state | Video | Network timing, state-machine logs |
| Accessibility | AX tree | Screenshot, labels, traits, focus order |
| Crash or hang | Crash report | Last screenshot, action trace, logs |

## Review criteria

### Static layout

- Check alignment, spacing, clipping, overlap, truncation, safe areas, and content priority.
- Compare AX frames with visible bounds; neither source alone is sufficient for every view.
- Test the relevant device size, orientation, locale, appearance, and Dynamic Type state.

### Motion

- Check that related surfaces move together and preserve the intended spatial relationship.
- Look for non-monotonic motion, late snaps, reversals, duplicate animation, relayout, flicker, stalls, and overshoot.
- Inspect the first divergence and the final settling, not only the endpoints.
- Compare opening and closing when the interaction is reversible.
- Treat simulator performance as directional; confirm performance-sensitive conclusions on a device.

### Input and interaction

- Confirm the intended element receives focus and exposes the correct accessibility role, label, value, and enabled state.
- Prefer semantic actions over coordinates. Use coordinates only when diagnosing geometry or hit testing.
- Check cancellation, interruption, interactive dismissal, repeated taps, and disabled states when relevant.

### Scroll behavior

- Identify the scroll owner and intended anchor before judging movement.
- Distinguish user-driven motion from content-size, viewport, keyboard, and programmatic changes.
- Verify near-edge and scrolled-away behavior separately.

### State and timing

- Align visible transitions with state-machine, network, and rendering logs.
- Treat absence of errors as evidence of logical consistency, not visual quality.
- Avoid inferring dropped UI frames from variable-frame-rate recording gaps alone.

## Verdict standard

Use one verdict and support it with observable evidence:

- **Reproduced**: the evidence shows the reported divergence.
- **Not reproduced**: the exact flow was exercised without the divergence; state the tested conditions.
- **Fixed**: the original reproduction fails before the change and passes afterward with comparable evidence.
- **Regressed**: the change worsens the target behavior or a relevant adjacent state.
- **Inconclusive**: the simulator, instrumentation, or recording cannot distinguish the outcomes.
