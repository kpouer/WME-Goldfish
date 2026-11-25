# Goldfish

Goldfish is a userscript (Tampermonkey / Greasemonkey) for the **Waze Map Editor (WME)**. It supports **Koifish**, the code name of Waze's project to integrate Google Maps into WME. It helps clean up segments imported or drawn in the editor: tiny segments, dangling nodes, unnamed segments, overly detailed geometry.

The UI follows the WME language (French and English are supported, English by default).

## What it does

### 1. Visual detection

Two layers are added to the map to spot problems. Detection updates automatically while you edit.

| Detection | Criterion | Display |
|---|---|---|
| Segments that are too short | Unsaved segments shorter than 1 m (haversine length). Existing segments are never reported. | Red circle at the segment's midpoint (a segment under 1 m is invisible). A badge on the button shows their count. |
| Unconnected nodes | Dangling node (on a new or existing segment) with another segment closer than 20 m. | A marker on the node. |

### 2. Cleanup actions

The toolbar holds a split button: the fish (**Clean**, runs all checked actions), one button per action (runs that action alone), then **▾** (options: which actions are checked). Actions are applied in this order:

| Button | Action | Segments concerned | Effect |
|---|---|---|---|
| 🗑 | Delete short segments | Unsaved segments < 1 m | Deletes them. |
| ⌫ | Clean | Unsaved segments | Sets an empty street name and no city (creates the empty city and street if needed). The name of a saved road is never erased. |
| St | Street type | Unsaved segments | Sets the *Street* road type. |
| ⛰ | Remove "unpaved" | Unsaved segments | Removes the *unpaved* attribute. |
| ⇄ | Two-way | Unsaved segments | Makes them two-way. |
| 〰 | Simplify geometry | Selection, otherwise the segments visible on the map | Merges segments joined by a useless node (see the country rules below), then removes useless shape points (Douglas-Peucker, 1 m tolerance, end points kept, repeated until nothing changes). Segments created by the merges are simplified too. |

A node is useless when it joins exactly two segments with the same road type, street, direction, *unpaved* flag, restrictions and speed limits.

### 3. Summary before applying

No action writes anything directly. Clicking a button first shows a **summary** of the planned changes, by category, with an estimate of the scripted edits against the hourly cap. Clicking a line selects the segments concerned, and the planned segments are surrounded by a halo (its color is set in the WME *Scripts* tab, green by default). Nothing is changed until you click **Apply**. If the map changed in the meantime, the summary is recomputed.

### 4. Report and undo

After applying, a report lists the changes made by type (a click selects the segments that still exist) and offers **Undo**, which reverts the whole run. Undo is refused if the map was edited since, and is no longer available after saving. Goldfish never saves anything by itself.

## Country rules

Goldfish follows by default the French community's [charter on scripts and mass editing](https://www.waze.com/discuss/t/scripts-et-edition-de-masse-la-doctrine-de-la-communaute-france/414279). The country is taken from the map (the main country in view) and shown in the toolbar, with the edit counter when the country is capped.

The **Default** row applies to France, to every country not configured in the script, and when the country is unknown (map without country, SDK error). Each other row is a configured country.

Settings that depend on the country:

| Country | Scripted edits per hour | 〰 Merge useless nodes |
|---|---|---|
| Default (France, non-configured countries, unknown country) | 500 (sliding hour) | Unsaved segments only (merging recreates the segment, charter §3.1) |
| AG | No cap (∞) | All segments (selection or visible ones) |

Functions that are the same in every country (not configurable):

| Function | Segments concerned |
|---|---|
| 🗑 Delete segments < 1 m | Unsaved segments only |
| ⌫ Clean (no name, no city) | Unsaved segments only |
| St Street type | Unsaved segments only |
| ⛰ Remove "unpaved" | Unsaved segments only |
| ⇄ Two-way | Unsaved segments only |
| 〰 Remove useless shape points | All segments (selection or visible ones) |
| Summary before applying, report, undo | Always active |

How the hourly cap is counted:

- Every modified object counts **once until it is saved**, whatever the number of actions on it. Deleting a short segment does not count (it was never saved).
- A merge counts its segments, plus the segment it creates.
- The count is kept per country, over a sliding hour, and shared between WME tabs. Edits move from *pending* to the hour's count when you save; a complete undo releases them.
- Before applying, the summary shows the estimated edits against what is left this hour. When the cap is reached during a run, the run stops, the following steps are skipped and a message is shown.

Configuring a country (top of `goldfish.user.js`, by WME country code or country name):

| Constant | Role | Current value |
|---|---|---|
| `DEFAULT_HOURLY_LIMIT` | Cap for every country absent from `COUNTRY_HOURLY_LIMITS` | `500` |
| `COUNTRY_HOURLY_LIMITS` | Per-country cap (`Infinity` = no cap) | `{ AG: Infinity }` |
| `PERMISSIVE_COUNTRIES` | Countries where merging is allowed on all segments | `['AG']` |

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or Greasemonkey.
2. Open `goldfish.user.js` and install it in the manager (or paste its contents into a new script).
3. Open <https://www.waze.com/editor> (or the beta editor). The Goldfish button appears in the edit toolbar; it can also be dragged to float freely.

## Usage

1. Draw or import segments, or select the ones to process.
2. Open **▾** to choose the actions run by **Clean**, or click a single action button.
3. Check the summary, then click **Apply**.
4. Check the result (or **Undo**), then save in WME as usual. Goldfish never saves anything by itself.

## Limitations

- Connecting two overlapping nodes is not possible: the WME SDK exposes no method that really merges two nodes.
- No test suite or build: the script is a single file.

## Development

See [CLAUDE.md](CLAUDE.md) for the architecture. The script uses the official WME SDK (`getWmeSdk`).

## License

[MIT](LICENSE)
