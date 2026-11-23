# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Goldfish is a single-file Tampermonkey/Greasemonkey userscript for the Waze Map Editor (WME): `goldfish.user.js`. There is no build system, package manager, linter or test suite. To try a change, install or reload the file in a userscript manager and open `https://www.waze.com/editor` (or the beta editor). The metadata block at the top sets `@version`, so bump it when releasing. Code comments and UI strings are in French; keep that convention.

## Architecture

Everything lives in one IIFE and uses the WME SDK (`getWmeSdk`, async mode, loaded after `window.SDK_INITIALIZED`) rather than the legacy `W` object. Startup runs `init()` after the `wme-ready` event. `init()` adds two map layers, builds the toolbar, registers events and runs the first `refresh()`.

- **Detection** (`findShortSegments`, `findUnconnectedNodes`): finds segments under `MAX_LENGTH_M` (1 m, haversine length) and dangling nodes on new segments.
  - The SDK has no "modified" flag, so "being edited" means a negative id (new segment) or an id in the `editedIds` set. `editedIds` is filled from data-model events and cleared on save, or when `getUnsavedChangesCount()` is 0.
- **Refresh loop** (`refresh`, `scheduleRefresh`, `registerEvents`): refresh is debounced by 250 ms and guarded against concurrent runs. A request that arrives mid-run sets `refreshAgain` and triggers another pass. Each pass recomputes detection results, redraws the highlight layers and updates the toolbar badge.
- **Actions** (`runClean` runs the checked steps in order):
  - `deleteShortSegments`: recomputes the targets, then deletes them.
  - `cleanNewSegments`: sets the empty-name street and Street road type on new segments. `getEmptyStreetId` creates the empty city and street if needed.
  - `simplifySelection`: merges selected segments joined by a node that connects exactly 2 segments of the same road type and street name, using union-find and `mergeSegments`.
  - `simplifyGeometry`: runs Douglas-Peucker (`DP_EPSILON_M` = 1 m, local equirectangular projection) on the selected segments. The end points are kept.
- **Toolbar UI** (`createToolbar` and helpers): a split button built with plain DOM and no framework. It is mounted in WME's `#edit-buttons`, or floated and draggable. The checkbox states and the floating position persist in `localStorage` under `wme-goldfish-prefs`.

Coordinates are GeoJSON `[lon, lat]` WGS84 throughout.
