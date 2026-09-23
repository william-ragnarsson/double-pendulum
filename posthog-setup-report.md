<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of the double-pendulum simulator with PostHog analytics. The project is a client-side browser application built with Vite and TypeScript, so `posthog-js` (the browser SDK) was used. A `src/analytics.ts` singleton initialises PostHog from environment variables and is imported by each file that captures events. Exception autocapture is enabled via `capture_exceptions: true`. Environment variables (`VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST`) are stored in `.env` and referenced via `import.meta.env` — never hardcoded.

In this session, 9 new `posthog.capture()` calls were added across 3 files. The existing 14 events already in place were left untouched.

| Event | Description | File |
|---|---|---|
| `simulation played` | User clicks Play to start the simulation | `src/main.ts` |
| `simulation paused` | User clicks Pause to stop the simulation | `src/main.ts` |
| `simulation reset` | User clicks Reset to restart from the initial state | `src/main.ts` |
| `pendulum count changed` | User changes the number of pendulums (`count`) | `src/main.ts` |
| `angle spread changed` | User changes the delta angle spread (`delta_angle_deg`) | `src/main.ts` |
| `simulation speed changed` | User adjusts the simulation speed slider (`steps_per_frame`) | `src/main.ts` |
| `physics parameters updated` | User changes any physics param — L1, L2, m1, m2, damping | `src/main.ts` |
| `physics parameters reset` | User resets physics to defaults | `src/main.ts` |
| `tab switched` | User switches tabs (`tab`: pendulum, phasemap, tech) | `src/main.ts` |
| `phase map resolution changed` | User changes the phase map grid resolution (`resolution`) | `src/main.ts` |
| `phase map color mode changed` | User changes the color mode visualization (`color_mode`) | `src/main.ts` |
| `phase map palette changed` | User changes the color palette (`palette`) | `src/main.ts` |
| `phase map speed changed` | User adjusts the phase map compute speed (`steps_per_dispatch`) | `src/main.ts` |
| `phase map played` | User resumes the phase map computation | `src/main.ts` |
| `phase map paused` | User pauses the phase map computation | `src/main.ts` |
| `phase map reset` | User resets the phase map to its initial state | `src/main.ts` |
| `phase map export started` | User starts a phase map export (`format`: png, mp4, webm, gif; `resolution`, `duration_seconds`, `color_mode`, `palette`, `region_type`; animations add `fps`, `length_seconds`, `ping_pong`) | `src/main.ts` |
| `phase map export completed` | Export finishes and the file is downloaded | `src/main.ts` |
| `phase map export cancelled` | User cancels an in-progress export | `src/main.ts` |
| `phase map export failed` | An export throws, e.g. no usable video encoder (`format`, `resolution`, `error`) | `src/main.ts` |
| `phase map probe clicked` | User clicks the map to probe an initial condition (`theta1`, `theta2`) | `src/views/PhaseMapView.ts` |
| `pendulum dragged` | User finishes dragging a pendulum bob to set initial conditions (`rod`) | `src/views/PendulumView.ts` |
| `tutorial started` | First-time visitor begins the onboarding tutorial | `src/tutorial/Tutorial.ts` |
| `tutorial completed` | New user completes all tutorial steps | `src/tutorial/Tutorial.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behaviour, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/471161/dashboard/1713976)
- [Tutorial onboarding funnel (wizard)](https://us.posthog.com/project/471161/insights/GTS18Nuz) — how many first-time visitors complete the tutorial
- [Daily active users (wizard)](https://us.posthog.com/project/471161/insights/IrbebnUN) — unique users who played the simulation each day
- [Phase map export conversion (wizard)](https://us.posthog.com/project/471161/insights/IUyLzIBl) — exports started vs completed
- [Tab navigation breakdown (wizard)](https://us.posthog.com/project/471161/insights/1PEn1To4) — which tabs users visit most
- [Deep feature engagement (wizard)](https://us.posthog.com/project/471161/insights/FbIyarfC) — users who dragged pendulums or probed the phase map

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-javascript_node/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
