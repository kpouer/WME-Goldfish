# Goldfish

Goldfish is a userscript (Tampermonkey / Greasemonkey) for the **Waze Map Editor (WME)**. It supports **Koifish**, the code name of Waze's project to integrate Google Maps into WME. It helps clean up segments imported or drawn in the editor: tiny segments, dangling nodes, unnamed segments, overly detailed geometry.

The UI follows the WME language (French and English are supported, English by default).

## What it does

Goldfish does two things:

### 1. Visual detection

Two layers are added to the map to spot problems:

- **Segments that are too short** (less than 1 m);
- **Unconnected nodes** on new segments.

A badge on the button shows the number of short segments detected. Detection updates automatically while you edit.

### 2. One-click cleanup

The **Clean** button runs the checked actions, in order:

| Action | Effect |
|---|---|
| Delete segments < 1 m | Deletes segments that are too short. |
| Clean new segments and the selection | Sets an empty street name and no city (creates the empty city and street if needed). |
| Street type | Sets unsaved segments and the selection to the *Street* road type. |
| Remove "unpaved" | Removes the *unpaved* attribute on those segments. |
| Two-way | Makes those segments two-way. |
| Simplify geometry | Removes useless shape points (Douglas-Peucker, 1 m tolerance, end points kept) and merges segments joined by a useless node (same type, same name). |

Actions apply to unsaved segments (new or modified) and to the current selection. The checked boxes are remembered.

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or Greasemonkey.
2. Open `goldfish.user.js` and install it in the manager (or paste its contents into a new script).
3. Open <https://www.waze.com/editor> (or the beta editor). The Goldfish button appears in the edit toolbar; it can also be dragged to float freely.

## Usage

1. Draw or import segments, or select the ones to process.
2. Open **Options** to choose the actions to run.
3. Click **Clean**.
4. Check the result, then save in WME as usual. Goldfish never saves anything by itself.

## Limitations

- Connecting two overlapping nodes is not possible: the WME SDK exposes no method that really merges two nodes.
- No test suite or build: the script is a single file.

## Development

See [CLAUDE.md](CLAUDE.md) for the architecture. The script uses the official WME SDK (`getWmeSdk`).

## License

[MIT](LICENSE)
