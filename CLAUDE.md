# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Goldfish is a single-file Tampermonkey/Greasemonkey userscript for the Waze Map Editor (WME): `goldfish.user.js`. There is no build system, package manager, linter or test suite. To try a change, install or reload the file in a userscript manager and open `https://www.waze.com/editor` (or the beta editor). The metadata block at the top sets `@version`, so bump it when releasing. Code comments and this file are written in English; keep that convention. UI strings are translated (French and English) in the `MESSAGES` table; the language comes from `sdk.Settings.getLocale()` (English by default). Add new strings to both languages and use `t(key)`.

## Architecture

Everything lives in one IIFE and uses the WME SDK (`getWmeSdk`, async mode, loaded after `window.SDK_INITIALIZED`) rather than the legacy `W` object. Startup runs `init()` after the `wme-ready` event. `init()` adds two map layers, builds the toolbar, registers events and runs the first `refresh()`.

- **Detection** (`findShortSegments`, `findUnconnectedNodes`): finds segments under `MAX_LENGTH_M` (1 m, haversine length) and dangling nodes (on new and existing segments) that have another segment within `NEAR_DISTANCE_M`.
  - Short segments are only unsaved ones (negative id): an existing segment is never reported nor deleted (charter). Each one is circled in red on the map (Point at its midpoint, since a segment under 1 m is invisible).
- **Refresh loop** (`refresh`, `scheduleRefresh`, `registerEvents`): refresh is debounced by 250 ms and guarded against concurrent runs. A request that arrives mid-run sets `refreshAgain` and triggers another pass. Each pass recomputes detection results, redraws the highlight layers and updates the toolbar badge.
- **Actions** (`runClean` runs the checked steps in order):
  - `deleteShortSegments`: recomputes the targets, then deletes them.
  - `cleanNewSegments`: sets the empty-name street on unsaved segments only (negative id), never on existing ones (charter: never erase the name of a saved road). `getEmptyStreetId` creates the empty city and street if needed.
  - `getTargetSegments`: segments targeted by the steps below (the selection, otherwise the segments visible in the map extent).
  - `simplifyGeometry`: merges useless nodes (`mergeUselessNodes`), limited to unsaved segments (negative id) where `mergeUnsavedOnly()` (default rule, i.e. every country not in `PERMISSIVE_COUNTRIES`, and when the country is unknown; `mergeSegments` recreates the segment, charter §3.1), on any segment in the permissive countries, then runs Douglas-Peucker (`DP_EPSILON_M` = 1 m, local equirectangular projection) on the selected segments. The end points are kept. The pass is repeated until no point is removed (fixed point), so applying it again leaves the segment unchanged.
- **Report and undo** (`logChange`, `showReport`, `undoLastRun`): every successful SDK write calls `logChange(type, ids)`. At the end of `runClean`, a panel below the bar lists the changes by type (a click selects the segments that still exist) and offers "Undo". Undo calls `sdk.Editing.undo()` as many times as `getUnsavedChangesCount()` increased during the run. It is refused if that counter changed since (another edit) and forgotten on save. A complete undo releases the run's quota reservations. Every new write must also call `logChange`.
- **Toolbar UI** (`createToolbar` and helpers): a split button built with plain DOM and no framework. It is mounted in WME's `#edit-buttons`, or floated and draggable. The checkbox states and the floating position persist in `localStorage` under `wme-goldfish-prefs`.

Coordinates are GeoJSON `[lon, lat]` WGS84 throughout.

## Editing charter (France)

When the script edits in France, it must follow the French community's charter on scripts and mass editing: https://www.waze.com/discuss/t/scripts-et-edition-de-masse-la-doctrine-de-la-communaute-france/414279. Any new editing action (or change to an existing one) must be checked against this doctrine before it is added.

### Scripted-edit cap (§3.3)

The French rules are the default rules, including for an unknown country (`UNKNOWN_COUNTRY`): `DEFAULT_HOURLY_LIMIT` (500 per sliding hour) and merging limited to unsaved segments. `PERMISSIVE_COUNTRIES` (at the top of the script) lists the countries where they are lifted (no cap, free merging). Every write goes through `reserveEdits(keys)` before the SDK call; a refusal sets `quotaBlocked`, shows a toast and stops the `runClean` steps. An object counts once per save (key `s<id>`). Reserved edits stay pending (`pendingEdits`), then move into the `wme-goldfish-quota` log (localStorage, per country, timestamped, re-read on every access so shared between tabs) on save. Every new write must call `reserveEdits`. The country comes from `Countries.getTopCountry()` (`refreshCountry`) and is shown in the toolbar with the counter if the country is capped (so everywhere except `PERMISSIVE_COUNTRIES`).

## Abandoned approach: connecting overlapping nodes

Target case: two segments whose end points are 0.00 m apart but carry two distinct nodes (different `fromNodeId`/`toNodeId`). The `connectCloseNodes` step (0.5 m tolerance) was meant to connect them before `simplifySelection` (merging segments of the same type and name joined by a node with exactly 2 segments, union-find + `mergeSegments`), which otherwise ignores them (node joined to only 1 segment). Both steps were removed because no SDK method really connects two nodes:

- `sdk.DataModel.Nodes` only exposes `getAll`, `getById`, `allowNodeTurns`, `moveNode`, `isVirtual`, `canEditTurns`, `canEdit`.
- `Nodes.moveNode({ id, geometry })` succeeds without error but does not merge: the nodes stay distinct (checked by re-reading `connectedSegmentIds`). Pitfall: never count a success without verifying it.
- `connectNodes`/`mergeNodes`/`joinNodes` do not exist.
- `Segments` also exposes `addSegment`, `addIntersection`, `splitSegment`, `updateSegment`, `deleteSegment`. Untested: their parameters are unknown (the methods are wrapped in a proxy, `String(fn)` shows nothing). A call with `{}` should surface the SDK validation and name the parameters.
- Remaining leads: `addSegment` with start and end node ids (to verify), or delete then recreate the segment with one end point on the neighbouring node (loses the attributes, which must be copied). Always verify the result with `connectedSegmentIds`.
- To list the methods of an SDK object, walk the whole prototype chain (`Object.keys` sees nothing).
