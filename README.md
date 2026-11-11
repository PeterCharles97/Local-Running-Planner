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

## Manual training blocks

Plan controls offer an optional manual block builder alongside automatic
generation. Choose run days and assign long- and quality-run days, then edit
the distance and workout for each individual run in every week. Long and easy
runs have their own execution notes. For quality runs, choose the workout type,
write the intervals and recovery, and enter a target pace. The builder creates
three build weeks and one deload week and schedules them after the weeks already
in the plan.

Open the active week and choose **Edit this block** to adjust the unfinished
runs in the current cycle without waiting for it to end. Completed runs and
earlier weeks are kept unchanged; the editor does not add another block.

After creating a manual block, **Draft next block from manual block** copies its
structure and offers a progress, hold, or reduce suggestion based on the
planner's current recommendation. The suggested distances and workout details
remain editable; the next block is only added after review. Manual blocks use
the normal completion and activity-history tracking. Week four is labeled as a
deload, but its distances and workout remain exactly as entered. A saved race
date produces an overlap reminder; manual blocks do not automatically taper
or stop on race day.

## Offline behavior

The service worker precaches the page, stylesheet, and script when installed.
It serves cached files immediately and refreshes them from the network when
available. Athlete data stays in `localStorage`; updating the app does not clear
it.
