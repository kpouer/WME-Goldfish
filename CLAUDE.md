# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Goldfish is a single-file Tampermonkey/Greasemonkey userscript for the Waze Map Editor (WME): `goldfish.user.js`. There is no build system, package manager, linter or test suite. To try a change, install or reload the file in a userscript manager and open `https://www.waze.com/editor` (or the beta editor). The metadata block at the top sets `@version`, so bump it when releasing. Code comments are in French; keep that convention. UI strings are translated (French and English) in the `MESSAGES` table; the language comes from `sdk.Settings.getLocale()` (English by default). Add new strings to both languages and use `t(key)`.

## Architecture

Everything lives in one IIFE and uses the WME SDK (`getWmeSdk`, async mode, loaded after `window.SDK_INITIALIZED`) rather than the legacy `W` object. Startup runs `init()` after the `wme-ready` event. `init()` adds two map layers, builds the toolbar, registers events and runs the first `refresh()`.

- **Detection** (`findShortSegments`, `findUnconnectedNodes`): finds segments under `MAX_LENGTH_M` (1 m, haversine length) and dangling nodes on new segments.
  - The SDK has no "modified" flag, so "being edited" means a negative id (new segment) or an id in the `editedIds` set. `editedIds` is filled from data-model events and cleared on save, or when `getUnsavedChangesCount()` is 0.
- **Refresh loop** (`refresh`, `scheduleRefresh`, `registerEvents`): refresh is debounced by 250 ms and guarded against concurrent runs. A request that arrives mid-run sets `refreshAgain` and triggers another pass. Each pass recomputes detection results, redraws the highlight layers and updates the toolbar badge.
- **Actions** (`runClean` runs the checked steps in order):
  - `deleteShortSegments`: recomputes the targets, then deletes them.
  - `cleanNewSegments`: sets the empty-name street and Street road type on new segments and on the selected segments. `getEmptyStreetId` creates the empty city and street if needed.
  - `getTargetSegments`: segments ciblés par les étapes ci-dessous (sélection, sinon segments visibles dans l'emprise de la carte).
  - `simplifyGeometry`: runs Douglas-Peucker (`DP_EPSILON_M` = 1 m, local equirectangular projection) on the selected segments. The end points are kept. The pass is repeated until no point is removed (fixed point), so applying it again leaves the segment unchanged.
- **Toolbar UI** (`createToolbar` and helpers): a split button built with plain DOM and no framework. It is mounted in WME's `#edit-buttons`, or floated and draggable. The checkbox states and the floating position persist in `localStorage` under `wme-goldfish-prefs`.

Coordinates are GeoJSON `[lon, lat]` WGS84 throughout.

## Piste abandonnée : relier des nœuds superposés

Cas visé : deux segments dont les extrémités sont à 0,00 m l'une de l'autre mais portent deux nœuds distincts (`fromNodeId`/`toNodeId` différents). L'étape `connectCloseNodes` (tolérance 0,5 m) devait les relier avant `simplifySelection` (fusion des segments de même type et même nom reliés par un nœud à exactement 2 segments, union-find + `mergeSegments`), qui les ignore sinon (nœud relié à 1 seul segment). Les deux étapes ont été retirées, faute de méthode SDK qui relie vraiment deux nœuds :

- `sdk.DataModel.Nodes` n'expose que `getAll`, `getById`, `allowNodeTurns`, `moveNode`, `isVirtual`, `canEditTurns`, `canEdit`.
- `Nodes.moveNode({ id, geometry })` réussit sans erreur mais ne fusionne pas : les nœuds restent distincts (vérifié en relisant `connectedSegmentIds`). Piège : ne pas compter un succès sans vérifier.
- `connectNodes`/`mergeNodes`/`joinNodes` n'existent pas.
- `Segments` expose aussi `addSegment`, `addIntersection`, `splitSegment`, `updateSegment`, `deleteSegment`. Non testés : leurs paramètres sont inconnus (les méthodes sont enveloppées dans un proxy, `String(fn)` ne montre rien). Un appel avec `{}` devrait faire remonter la validation du SDK et nommer les paramètres.
- Pistes restantes : `addSegment` avec des ids de nœuds de départ et d'arrivée (à vérifier), ou supprimer puis recréer le segment avec une extrémité sur le nœud voisin (perd les attributs, à recopier). Vérifier toujours le résultat avec `connectedSegmentIds`.
- Pour lister les méthodes d'un objet SDK, parcourir toute la chaîne de prototypes (`Object.keys` ne voit rien).
