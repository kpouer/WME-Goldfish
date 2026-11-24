# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Goldfish is a single-file Tampermonkey/Greasemonkey userscript for the Waze Map Editor (WME): `goldfish.user.js`. There is no build system, package manager, linter or test suite. To try a change, install or reload the file in a userscript manager and open `https://www.waze.com/editor` (or the beta editor). The metadata block at the top sets `@version`, so bump it when releasing. Code comments are in French; keep that convention. UI strings are translated (French and English) in the `MESSAGES` table; the language comes from `sdk.Settings.getLocale()` (English by default). Add new strings to both languages and use `t(key)`.

## Architecture

Everything lives in one IIFE and uses the WME SDK (`getWmeSdk`, async mode, loaded after `window.SDK_INITIALIZED`) rather than the legacy `W` object. Startup runs `init()` after the `wme-ready` event. `init()` adds two map layers, builds the toolbar, registers events and runs the first `refresh()`.

- **Detection** (`findShortSegments`, `findUnconnectedNodes`): finds segments under `MAX_LENGTH_M` (1 m, haversine length) and dangling nodes (on new and existing segments) that have another segment within `NEAR_DISTANCE_M`.
  - Short segments are only unsaved ones (negative id): an existing segment is never reported nor deleted (charte). Each one is circled in red on the map (Point at its midpoint, since a segment under 1 m is invisible).
- **Refresh loop** (`refresh`, `scheduleRefresh`, `registerEvents`): refresh is debounced by 250 ms and guarded against concurrent runs. A request that arrives mid-run sets `refreshAgain` and triggers another pass. Each pass recomputes detection results, redraws the highlight layers and updates the toolbar badge.
- **Actions** (`runClean` runs the checked steps in order):
  - `deleteShortSegments`: recomputes the targets, then deletes them.
  - `cleanNewSegments`: sets the empty-name street on unsaved segments only (negative id), never on existing ones (charte : ne pas effacer le nom d'une route enregistrée). `getEmptyStreetId` creates the empty city and street if needed.
  - `getTargetSegments`: segments ciblés par les étapes ci-dessous (sélection, sinon segments visibles dans l'emprise de la carte).
  - `simplifyGeometry`: merges useless nodes (`mergeUselessNodes`), limited to unsaved segments (negative id) where `mergeUnsavedOnly()` (default rule, i.e. every country not in `PERMISSIVE_COUNTRIES`, and when the country is unknown; `mergeSegments` recreates the segment, charte §3.1), on any segment in the permissive countries, then runs Douglas-Peucker (`DP_EPSILON_M` = 1 m, local equirectangular projection) on the selected segments. The end points are kept. The pass is repeated until no point is removed (fixed point), so applying it again leaves the segment unchanged.
- **Rapport et annulation** (`logChange`, `showReport`, `undoLastRun`) : chaque écriture SDK réussie appelle `logChange(type, ids)`. À la fin de `runClean`, un panneau sous la barre liste les changements par type (un clic sélectionne les segments encore présents) et propose « Annuler ». L'annulation appelle `sdk.Editing.undo()` autant de fois que `getUnsavedChangesCount()` a augmenté pendant l'exécution. Elle est refusée si ce compteur a changé depuis (autre édition) et oubliée à l'enregistrement. Une annulation complète libère les réservations de quota de l'exécution. Toute nouvelle écriture doit aussi appeler `logChange`.
- **Toolbar UI** (`createToolbar` and helpers): a split button built with plain DOM and no framework. It is mounted in WME's `#edit-buttons`, or floated and draggable. The checkbox states and the floating position persist in `localStorage` under `wme-goldfish-prefs`.

Coordinates are GeoJSON `[lon, lat]` WGS84 throughout.

## Charte d'édition (France)

Lorsque le script édite en France, il doit respecter la charte d'édition de la communauté française sur les scripts et l'édition de masse : https://www.waze.com/discuss/t/scripts-et-edition-de-masse-la-doctrine-de-la-communaute-france/414279. Toute nouvelle action d'édition (ou modification d'une action existante) doit être vérifiée au regard de cette doctrine avant d'être ajoutée.

### Plafond d'éditions scriptées (§3.3)

Les règles de la France sont les règles par défaut, y compris pays inconnu (`UNKNOWN_COUNTRY`) : `DEFAULT_HOURLY_LIMIT` (500 par heure glissante) et fusion limitée aux segments non enregistrés. `PERMISSIVE_COUNTRIES` (en haut du script) liste les pays où elles sont levées (pas de plafond, fusion libre). Toute écriture passe par `reserveEdits(clés)` avant l'appel SDK ; un refus positionne `quotaBlocked`, affiche un toast et interrompt les étapes de `runClean`. Un objet compte une fois par enregistrement (clé `s<id>`). Les éditions réservées restent en attente (`pendingEdits`), puis passent dans le journal `wme-goldfish-quota` (localStorage, par pays, horodaté, relu à chaque accès donc partagé entre onglets) à l'enregistrement. Toute nouvelle écriture doit appeler `reserveEdits`. Le pays vient de `Countries.getTopCountry()` (`refreshCountry`) et s'affiche dans la toolbar avec le compteur si le pays est plafonné (donc partout sauf `PERMISSIVE_COUNTRIES`).

## Piste abandonnée : relier des nœuds superposés

Cas visé : deux segments dont les extrémités sont à 0,00 m l'une de l'autre mais portent deux nœuds distincts (`fromNodeId`/`toNodeId` différents). L'étape `connectCloseNodes` (tolérance 0,5 m) devait les relier avant `simplifySelection` (fusion des segments de même type et même nom reliés par un nœud à exactement 2 segments, union-find + `mergeSegments`), qui les ignore sinon (nœud relié à 1 seul segment). Les deux étapes ont été retirées, faute de méthode SDK qui relie vraiment deux nœuds :

- `sdk.DataModel.Nodes` n'expose que `getAll`, `getById`, `allowNodeTurns`, `moveNode`, `isVirtual`, `canEditTurns`, `canEdit`.
- `Nodes.moveNode({ id, geometry })` réussit sans erreur mais ne fusionne pas : les nœuds restent distincts (vérifié en relisant `connectedSegmentIds`). Piège : ne pas compter un succès sans vérifier.
- `connectNodes`/`mergeNodes`/`joinNodes` n'existent pas.
- `Segments` expose aussi `addSegment`, `addIntersection`, `splitSegment`, `updateSegment`, `deleteSegment`. Non testés : leurs paramètres sont inconnus (les méthodes sont enveloppées dans un proxy, `String(fn)` ne montre rien). Un appel avec `{}` devrait faire remonter la validation du SDK et nommer les paramètres.
- Pistes restantes : `addSegment` avec des ids de nœuds de départ et d'arrivée (à vérifier), ou supprimer puis recréer le segment avec une extrémité sur le nœud voisin (perd les attributs, à recopier). Vérifier toujours le résultat avec `connectedSegmentIds`.
- Pour lister les méthodes d'un objet SDK, parcourir toute la chaîne de prototypes (`Object.keys` ne voit rien).
