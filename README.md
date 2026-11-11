# Local Running Planner

A running planner that works locally in your browser. The plan is stored on
your device, so it does not need an account or a server.

## Project layout

- [`index.html`](./index.html) contains the page structure and dialogs.
- [`styles.css`](./styles.css) contains the page styling and theme.
- [`app.js`](./app.js) contains the planner state, training rules, rendering,
  and interactions.
- [`sw.js`](./sw.js) caches the app files for offline use and refreshes them
  when a newer version is available.

The HTML loads the stylesheet in the document head and the classic JavaScript
file at the end of the body. The script stays a classic script because the HTML
uses inline event handlers such as `onclick="openSettings()"`.

## How the app starts

1. `boot()` loads the saved plan from browser `localStorage` (or creates a
   default plan), fills in fields added by newer versions, and migrates older
   saved weeks.
2. It updates past weeks, prunes old history, saves the current state, and
   calls `renderAll()` to draw the page.
3. If this is a new plan, the onboarding dialog collects starting preferences
   and training levels.
4. User actions update the in-memory `DB`, save it, and redraw the relevant
   part of the page.

The storage key is `rolling_training_platform_v1`. Clearing browser site data
or using a different browser/device will remove or not include that saved plan.

## Understanding the planner logic

`DB` is the app's central state object:

- `workspace` holds athlete preferences and current training settings.
- `cycles` and `weeks` hold generated plans.
- `overrides` stores per-session edits, such as moved days and completion.
- `extras` stores additional workouts added by the athlete.
- `results` stores logged activities and links to planned sessions.
- `rolling` stores recent training feedback used to guide future cycles.
- `meta` stores migration, onboarding, and undo flags.

`generateCycle(mode)` builds the next cycle from the current settings and
training history. `computeRecommendation()` applies the rule-based checks that
choose whether the next cycle should progress, hold, or reduce training load.
`renderAll()` turns the current state into the visible page. The code is
organized into labeled sections in `app.js`; start there when tracing a feature.

## Offline behavior

The service worker precaches the page, stylesheet, and script when installed.
It serves cached files immediately and refreshes them from the network when
available. Athlete data stays in `localStorage`; updating the app does not clear
it.
