// ==UserScript==
// @name         WME Goldfish
// @namespace    https://github.com/kpouer/wme-goldfish
// @version      0.12.0
// @description  Goldfish, a fish to help you manage Koifish
// @description:fr  Goldfish un poisson pour vous aider à gérer Koifish
// @description:en  Goldfish, a fish to help you manage Koifish
// @author       kpouer
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @grant        none
// ==/UserScript==

/* global getWmeSdk, GM_info */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-goldfish';
    const SCRIPT_NAME = 'Goldfish';
    const SCRIPT_VERSION = typeof GM_info !== 'undefined' ? GM_info.script.version : '?';
    const LAYER_NAME = 'goldfish-short-segments';
    const UNCONNECTED_LAYER_NAME = 'goldfish-unconnected-segments';
    const NEAR_DISTANCE_M = 20;    // an unconnected node is only reported if a segment is closer than this
    const MAX_LENGTH_M = 1;        // segments strictly shorter than 1 m
    const REFRESH_DELAY_MS = 250;  // refresh debounce
    const STREET_ROAD_TYPE = 1;    // WME id of the "Street" road type
    const EARTH_RADIUS_M = 6371008.8;
    const DP_EPSILON_M = 1;        // Douglas-Peucker tolerance in meters
    const PREFS_KEY = `${SCRIPT_ID}-prefs`;
    const QUOTA_KEY = `${SCRIPT_ID}-quota`;
    const QUOTA_WINDOW_MS = 60 * 60 * 1000;  // one-hour sliding window
    const QUOTA_DISPLAY_MS = 30 * 1000;      // display refresh (edits leave the window)
    // Default rules = French charter: cap of 500 scripted edits per hour (§3.3), segment merging
    // limited to unsaved segments. They apply everywhere, including when the country is unknown.
    const DEFAULT_HOURLY_LIMIT = 500;
    // Countries where the permissive rules apply (no hourly cap, merging of all segments).
    // Entries: WME country code (e.g. 'BE') or country name. List to be determined.
    const PERMISSIVE_COUNTRIES = new Set([
        // 'BE',
    ]);
    /** Unknown country (map without country, SDK error): treated like France. */
    const UNKNOWN_COUNTRY = { key: '?', label: '?', name: '?' };

    /** @type {import('wme-sdk-typings').WmeSDK} */
    let sdk;
    let toolbar;
    let body;
    let countLabel;
    let cleanButton;
    const checkboxes = {};
    /** Text nodes of the checkbox labels (some change depending on the country). */
    const optionLabels = {};
    let toggleButton;
    let expanded = false;
    let floating = false;
    let grip;
    let refreshTimer = null;
    let refreshing = false;
    let refreshAgain = false;
    let quotaLabel;
    /** Current country: { key, label, name } (UNKNOWN_COUNTRY if unknown). */
    let currentCountry = UNKNOWN_COUNTRY;
    /** Unsaved scripted edits: country key -> Set of object keys (an object counts once). */
    const pendingEdits = new Map();
    /** True when the cap interrupted the current run. */
    let quotaBlocked = false;
    /** True while Clean runs: reserved edits are not all written yet. */
    let cleanRunning = false;
    /** Log of the current Clean run: change type -> { ids, extra }. */
    let runLog = null;
    /** Last undoable run: { log, beforeCount, afterCount, actions, freshKeys } (null if nothing to undo). */
    let lastRun = null;
    let reportPanel;

    /** Current result: [{ id, length, geometry }] (unsaved segments < MAX_LENGTH_M) */
    let shortSegments = [];
    /** Unconnected nodes of the segments */
    let unconnectedNodes = [];

    // ---------------------------------------------------------------- init

    // ------------------------------------------------------------- i18n
    const MESSAGES = {
        fr: {
            tabDesc: () => `Goldfish, un poisson pour vous aider à gérer Koifish`,
            grip: 'Déplacer (double-clic : réinitialiser)',
            optHide: 'Masquer les options',
            optShow: 'Options',
            cleanTitle: 'Clean : exécute les actions cochées',
            cleanTitleCount: (n) => `Clean : exécute les actions cochées (${n} segment${n > 1 ? 's' : ''} < ${MAX_LENGTH_M} m)`,
            delete: `Supprimer les segments non enregistrés < ${MAX_LENGTH_M} m`,
            clean: 'Nettoyer les segments non enregistrés (sans nom, sans ville)',
            roadType: 'Type Street (segments non enregistrés)',
            unpaved: 'Retirer « non bitumé » (segments non enregistrés)',
            twoWay: 'Double sens (segments non enregistrés)',
            geometry: 'Simplifier la géométrie (points de forme, nœuds inutiles)',
            geometryMergeUnsaved: 'Simplifier la géométrie (points de forme, nœuds inutiles ; fusion limitée aux segments non enregistrés)',
            mergeFailed: (msg) => `Goldfish : fusion impossible (${msg})`,
            reportTitle: 'Goldfish : changements effectués',
            reportNone: 'Aucun changement',
            reportStopped: 'Interrompu : plafond horaire atteint',
            reportSelect: 'Cliquer pour sélectionner les segments encore présents',
            undo: 'Annuler',
            close: 'Fermer',
            undoDone: (n) => `Goldfish : ${n} action(s) annulée(s)`,
            undoStale: 'Goldfish : la carte a été modifiée depuis, annulation impossible (utilisez l\'annulation de WME)',
            undoFailed: 'Goldfish : annulation incomplète',
            logDelete: (n) => `${n} segment(s) < ${MAX_LENGTH_M} m supprimé(s)`,
            logClean: (n) => `${n} segment(s) passé(s) sans nom ni ville`,
            logRoadType: (n) => `${n} segment(s) passé(s) en type Street`,
            logUnpaved: (n) => `« Non bitumé » retiré sur ${n} segment(s)`,
            logTwoWay: (n) => `${n} segment(s) passé(s) en double sens`,
            logMerge: (n) => `${n} fusion(s) de segments (nœuds inutiles)`,
            logGeometry: (n, p) => `${n} segment(s) simplifié(s) (${p} point(s) de forme retiré(s))`,
            quotaTitle: (name, used, limit, pending) => `${name} : ${used}/${limit} éditions scriptées sur la dernière heure (+ ${pending} en attente d'enregistrement)`,
            quotaCountry: (name) => `Pays : ${name} (pas de plafond d'éditions scriptées)`,
            quotaReached: (name, limit) => `Goldfish : plafond de ${limit} éditions scriptées par heure atteint (${name}), actions interrompues`,
        },
        en: {
            tabDesc: () => `Goldfish, a fish to help you manage Koifish`,
            grip: 'Move (double-click: reset)',
            optHide: 'Hide options',
            optShow: 'Options',
            cleanTitle: 'Clean: runs the checked actions',
            cleanTitleCount: (n) => `Clean: runs the checked actions (${n} segment${n > 1 ? 's' : ''} < ${MAX_LENGTH_M} m)`,
            delete: `Delete unsaved segments < ${MAX_LENGTH_M} m`,
            clean: 'Clean unsaved segments (no name, no city)',
            roadType: 'Street type (unsaved segments)',
            unpaved: 'Remove "unpaved" (unsaved segments)',
            twoWay: 'Two-way (unsaved segments)',
            geometry: 'Simplify geometry (shape points, useless nodes)',
            geometryMergeUnsaved: 'Simplify geometry (shape points, useless nodes; merge limited to unsaved segments)',
            mergeFailed: (msg) => `Goldfish: merge failed (${msg})`,
            reportTitle: 'Goldfish: changes made',
            reportNone: 'No change',
            reportStopped: 'Stopped: hourly limit reached',
            reportSelect: 'Click to select the segments that still exist',
            undo: 'Undo',
            close: 'Close',
            undoDone: (n) => `Goldfish: ${n} action(s) undone`,
            undoStale: 'Goldfish: the map was edited since, cannot undo (use WME undo)',
            undoFailed: 'Goldfish: undo incomplete',
            logDelete: (n) => `${n} segment(s) < ${MAX_LENGTH_M} m deleted`,
            logClean: (n) => `${n} segment(s) set to no name, no city`,
            logRoadType: (n) => `${n} segment(s) set to Street type`,
            logUnpaved: (n) => `"Unpaved" removed on ${n} segment(s)`,
            logTwoWay: (n) => `${n} segment(s) set to two-way`,
            logMerge: (n) => `${n} segment merge(s) (useless nodes)`,
            logGeometry: (n, p) => `${n} segment(s) simplified (${p} shape point(s) removed)`,
            quotaTitle: (name, used, limit, pending) => `${name}: ${used}/${limit} scripted edits in the last hour (+ ${pending} pending save)`,
            quotaCountry: (name) => `Country: ${name} (no scripted-edit limit)`,
            quotaReached: (name, limit) => `Goldfish: hourly limit of ${limit} scripted edits reached (${name}), actions stopped`,
        },
    };
    let lang = 'en';
    /** Translated text (WME language, English by default). */
    function t(key, ...args) {
        const v = MESSAGES[lang][key] ?? MESSAGES.en[key];
        return typeof v === 'function' ? v(...args) : v;
    }
    /** Picks the language from the WME locale (fallback: browser language). */
    function detectLang() {
        let code = '';
        try { code = sdk.Settings.getLocale()?.localeCode ?? ''; } catch (e) { /* fallback below */ }
        code = (code || document.documentElement.lang || navigator.language || '').toLowerCase();
        lang = code.startsWith('fr') ? 'fr' : 'en';
    }

    window.SDK_INITIALIZED.then(() => {
        sdk = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
        sdk.Events.once({ eventName: 'wme-ready' }).then(init);
    });

    async function init() {
        detectLang();
        await sdk.Map.addLayer({
            layerName: LAYER_NAME,
            styleRules: [{
                style: {
                    strokeColor: '#ff0000',
                    strokeOpacity: 1,
                    strokeWidth: 3,
                    fillColor: '#ff0000',
                    fillOpacity: 0,
                    pointRadius: 24,
                },
            }],
        });
        await sdk.Map.addLayer({
            layerName: UNCONNECTED_LAYER_NAME,
            styleRules: [{
                style: {
                    strokeColor: '#ff0000',
                    strokeOpacity: 1,
                    strokeWidth: 2,
                    fillColor: '#ff0000',
                    fillOpacity: 0,
                    pointRadius: 16,
                },
            }],
        });
        await registerScriptTab();
        createToolbar();
        registerEvents();
        // Display only: old edits leave the one-hour window, or another tab saved them.
        setInterval(updateQuotaLabel, QUOTA_DISPLAY_MS);
        window.addEventListener('storage', (e) => e.key === QUOTA_KEY && updateQuotaLabel());
        await refresh();
        console.log(`[${SCRIPT_ID}] chargé`);
    }

    /** WME "Scripts" tab: script name and version. */
    async function registerScriptTab() {
        try {
            const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
            const tabIcon = document.createElement('img');
            tabIcon.src = FISH_ICON_URL;
            tabIcon.alt = '';
            Object.assign(tabIcon.style, { width: '16px', height: '16px', verticalAlign: 'middle', marginRight: '4px' });
            tabLabel.append(tabIcon, SCRIPT_NAME);
            tabLabel.title = `${SCRIPT_NAME} v${SCRIPT_VERSION}`;
            const title = document.createElement('h4');
            title.textContent = `${SCRIPT_NAME} v${SCRIPT_VERSION}`;
            const desc = document.createElement('p');
            desc.textContent = t('tabDesc', MAX_LENGTH_M);
            tabPane.append(title, desc);
        } catch (e) {
            console.warn(`[${SCRIPT_ID}] impossible d'enregistrer l'onglet Scripts`, e);
        }
    }

    // --------------------------------------------------------- detection

    /** Haversine distance in meters between two GeoJSON positions [lon, lat]. */
    function haversine([lon1, lat1], [lon2, lat2]) {
        const rad = Math.PI / 180;
        const dLat = (lat2 - lat1) * rad;
        const dLon = (lon2 - lon1) * rad;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
    }

    /** Length in meters of a GeoJSON LineString (lon/lat WGS84). */
    function lineLength(geometry) {
        const c = geometry.coordinates;
        let total = 0;
        for (let i = 1; i < c.length; i++) total += haversine(c[i - 1], c[i]);
        return total;
    }

    /** Unsaved segments (negative id) shorter than MAX_LENGTH_M: never an existing segment. */
    async function findShortSegments() {
        const segments = await sdk.DataModel.Segments.getAll();
        const result = [];
        for (const segment of segments) {
            if (segment.id >= 0) continue;
            const length = lineLength(segment.geometry);
            if (length < MAX_LENGTH_M) result.push({ id: segment.id, length, geometry: segment.geometry });
        }
        return result;
    }

    /** True if a segment other than `ownIds` passes within NEAR_DISTANCE_M of `point` ([lon, lat]). */
    function hasSegmentNearby(point, allSegments, ownIds) {
        const rad = Math.PI / 180;
        const cos = Math.cos(point[1] * rad);
        const proj = ([lon, lat]) => ({
            x: (lon - point[0]) * rad * cos * EARTH_RADIUS_M,
            y: (lat - point[1]) * rad * EARTH_RADIUS_M,
        });
        const origin = { x: 0, y: 0 };
        for (const seg of allSegments) {
            if (ownIds.has(seg.id)) continue;
            const c = seg.geometry.coordinates;
            for (let i = 1; i < c.length; i++) {
                if (pointToSegmentDist(origin, proj(c[i - 1]), proj(c[i])) < NEAR_DISTANCE_M) return true;
            }
        }
        return false;
    }

    /** Nodes of segments (new or existing) not connected to another segment, with a segment within 20 m. */
    async function findUnconnectedNodes() {
        const nodes = new Map();
        const allSegments = await sdk.DataModel.Segments.getAll();
        for (const segment of allSegments) {
            for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
                if (nodeId == null || nodes.has(nodeId)) continue;
                const node = await sdk.DataModel.Nodes.getById({ nodeId });
                if (!node) continue;
                const others = (node.connectedSegmentIds ?? []).filter((id) => id !== segment.id);
                if (others.length === 0 && hasSegmentNearby(node.geometry.coordinates, allSegments, new Set([segment.id]))) {
                    nodes.set(nodeId, node);
                }
            }
        }
        console.log(`[${SCRIPT_ID}] noeuds non connectés : ${nodes.size}`);
        return [...nodes.values()];
    }

    // ------------------------------------------------------ highlighting

    /** Midpoint (average of the end points) of a LineString: enough for a segment under one meter. */
    function lineMidpoint(geometry) {
        const c = geometry.coordinates;
        const [lon1, lat1] = c[0];
        const [lon2, lat2] = c[c.length - 1];
        return [(lon1 + lon2) / 2, (lat1 + lat2) / 2];
    }

    async function drawHighlights() {
        await sdk.Map.removeAllFeaturesFromLayer({ layerName: UNCONNECTED_LAYER_NAME });
        for (const { id, geometry } of unconnectedNodes) {
            await sdk.Map.addFeatureToLayer({
                layerName: UNCONNECTED_LAYER_NAME,
                feature: {
                    type: 'Feature',
                    id: `goldfish-node-${id}`,
                    geometry,
                    properties: { nodeId: id },
                },
            });
        }
        await sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME });
        for (const { id, geometry } of shortSegments) {
            await sdk.Map.addFeatureToLayer({
                layerName: LAYER_NAME,
                // A segment < 1 m is invisible: circle it in red, centered on its midpoint.
                feature: { type: 'Feature', id: `goldfish-${id}`, geometry: { type: 'Point', coordinates: lineMidpoint(geometry) }, properties: { segmentId: id } },
            });
        }
    }

    // ------------------------------------------------------------ quota

    /** Log of saved edits: { [country]: [[timestamp, count], ...] }, re-read on each access (shared between tabs). */
    function loadQuota() {
        let data = {};
        try {
            data = JSON.parse(localStorage.getItem(QUOTA_KEY)) ?? {};
        } catch (e) { /* unreadable log: start from scratch */ }
        const since = Date.now() - QUOTA_WINDOW_MS;
        const clean = {};
        for (const [key, entries] of Object.entries(data)) {
            if (!Array.isArray(entries)) continue;
            const recent = entries.filter((e) => Array.isArray(e) && e[0] > since && e[1] > 0);
            if (recent.length) clean[key] = recent;
        }
        return clean;
    }

    function saveQuota(data) {
        try {
            localStorage.setItem(QUOTA_KEY, JSON.stringify(data));
        } catch (e) {
            // storage unavailable: the counter will not survive a reload
        }
    }

    /** Edits saved in the last hour for this country. */
    function committedCount(key) {
        return (loadQuota()[key] ?? []).reduce((sum, [, n]) => sum + n, 0);
    }

    function pendingCount(key) {
        return pendingEdits.get(key)?.size ?? 0;
    }

    /** True if the country follows the permissive rules (PERMISSIVE_COUNTRIES list); otherwise: French charter rules. */
    function isPermissive(country) {
        return PERMISSIVE_COUNTRIES.has(country.key) || PERMISSIVE_COUNTRIES.has(country.name);
    }

    /** Hourly cap of the country (null: no cap). */
    function limitFor(country) {
        return isPermissive(country) ? null : DEFAULT_HOURLY_LIMIT;
    }

    /** True if merging must only touch unsaved segments in the current country. */
    function mergeUnsavedOnly() {
        return !isPermissive(currentCountry);
    }

    function toCountryInfo(country) {
        const name = country.name ?? String(country.id);
        const key = country.abbr ?? name;
        return { key, label: key, name };
    }

    async function refreshCountry() {
        try {
            const country = await sdk.DataModel.Countries.getTopCountry();
            currentCountry = country ? toCountryInfo(country) : UNKNOWN_COUNTRY;
        } catch (e) {
            currentCountry = UNKNOWN_COUNTRY;
        }
    }

    /**
     * Reserves edits (object keys) before writing. Returns false, reserving nothing, if the country's
     * hourly cap would be exceeded. An object already modified and awaiting save counts only once.
     */
    function reserveEdits(keys) {
        if (quotaBlocked) return false;
        const pending = pendingEdits.get(currentCountry.key) ?? new Set();
        const fresh = keys.filter((k) => !pending.has(k));
        const limit = limitFor(currentCountry);
        if (limit != null && committedCount(currentCountry.key) + pending.size + fresh.length > limit) {
            quotaBlocked = true;
            showToast(t('quotaReached', currentCountry.name, limit), 6000);
            updateQuotaLabel();
            return false;
        }
        for (const k of fresh) pending.add(k);
        pendingEdits.set(currentCountry.key, pending);
        updateQuotaLabel();
        return true;
    }

    /** Drops the pending reservations (all changes undone without saving). */
    function discardPendingEdits() {
        if (pendingEdits.size === 0) return;
        pendingEdits.clear();
        updateQuotaLabel();
    }

    /** Pending edits go into the log only on save (the charter counts them at that point). */
    function commitPendingEdits() {
        if (pendingEdits.size === 0) return;
        const data = loadQuota();
        const now = Date.now();
        for (const [key, keys] of pendingEdits) {
            if (keys.size === 0) continue;
            (data[key] ??= []).push([now, keys.size]);
        }
        pendingEdits.clear();
        saveQuota(data);
        updateQuotaLabel();
    }

    /** Current country and last-hour counter in the toolbar (counter only if the country has a cap). */
    function updateQuotaLabel() {
        if (!quotaLabel) return;
        const limit = limitFor(currentCountry);
        if (limit == null) {
            quotaLabel.textContent = currentCountry.label;
            quotaLabel.style.color = '#888';
            quotaLabel.title = t('quotaCountry', currentCountry.name);
            return;
        }
        const pending = pendingCount(currentCountry.key);
        // The displayed counter only includes saved edits; pending reservations still
        // count toward the cap (reserveEdits) and are shown in the tooltip.
        const used = committedCount(currentCountry.key);
        quotaLabel.textContent = `${currentCountry.label} ${used}/${limit}`;
        const total = used + pending;
        quotaLabel.style.color = total >= limit ? '#c62828' : total >= limit * 0.8 ? '#e65100' : '#555';
        quotaLabel.title = t('quotaTitle', currentCountry.name, used, limit, pending);
    }

    // ----------------------------------------------------------- toolbar

    const BTN_STYLE = {
        height: '32px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        font: '13px sans-serif',
        color: 'inherit',
    };

    /** Visual feedback on a button: hover and press (the button "moves" on click). */
    function addPressFeedback(button) {
        const set = (background, transform) => {
            if (button.disabled) return;
            button.style.background = background;
            button.style.transform = transform;
        };
        button.style.transition = 'background 0.1s, transform 0.1s';
        button.addEventListener('mouseenter', () => set('#eef3f8', 'none'));
        button.addEventListener('mouseleave', () => set('transparent', 'none'));
        button.addEventListener('pointerdown', () => set('#cfdcea', 'scale(0.9) translateY(1px)'));
        button.addEventListener('pointerup', () => set('#eef3f8', 'none'));
        button.addEventListener('pointercancel', () => set('transparent', 'none'));
    }

    /** Fish icon (inline SVG, served as a data URI to avoid HTML injection). */
    const FISH_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g fill="#F37934"><path d="M240.835,288.625c-19.528,25.107-64.51,122.453-145.4,116.873c-80.901-5.579-89.27-58.583-89.27-58.583c13.948,0,69.015,22.068,75.603-22.828c8.684-59.159,90.377-62.252,90.377-62.252c-71.131-2.79-59.039-53.905-84.949-72.347C58.974,169.408,0,199.074,0,199.074c61.503-209.497,234.181,16.781,234.181,16.781c-13.21,10.377-21.59,21.862-21.59,33.954C212.591,263.822,223.847,277.022,240.835,288.625z"/><path d="M428.437,179.378c-14.969-6.111-31.88-9.997-50.67-9.997c-23.305,0-66.008,9.52-102.632,24.89c-41.444-46.708,4.982-63.815,13.981-63.945c17.596-0.25,43.321,0,97.02-20.928C439.834,88.48,428.437,179.378,428.437,179.378z"/><path d="M429.368,367.453c-24.999,18.138-117.351,11.875-116.58-2.725c1.042-19.81,9.965-31.783,19.549-40.586c17.161,3.929,32.673,6.09,43.777,6.09c23.023,0,43.224-5.84,60.483-14.437C442.437,324.305,453.422,346.091,429.368,367.453z"/></g><path fill="#FBA026" d="M512,249.803c0,0-25.313,45.308-73.4,69.243c-17.27,8.608-37.471,14.448-60.494,14.448c-46.22,0-168.77-37.471-168.77-83.69c0-22.914,30.133-43.68,66.138-58.789c36.624-15.37,79.327-24.89,102.632-24.89c18.79,0,35.701,3.886,50.67,9.997C483.235,198.319,512,249.803,512,249.803z"/><g fill="#F37934"><path d="M512,249.803c0,0-25.313,45.308-73.4,69.243h-0.011c-12.841-7.077-36.602-28.515-36.602-69.243s16.89-63.023,26.79-73.682C483.235,198.319,512,249.803,512,249.803z"/><path d="M363.809,226.055c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V226.055z"/><path d="M363.809,269.113c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V269.113z"/><path d="M363.809,312.169c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V312.169z"/><path d="M304.107,233.808c-7.608,0-13.777-6.168-13.777-13.777c0-7.609,6.168-13.777,13.777-13.777V233.808z"/><path d="M304.107,261.361c-7.608,0-13.777-6.168-13.777-13.777c0-7.608,6.168-13.777,13.777-13.777V261.361z"/><path d="M304.107,288.913c-7.608,0-13.777-6.168-13.777-13.777c0-7.608,6.168-13.777,13.777-13.777V288.913z"/></g><circle fill="#CA463D" cx="446.229" cy="238.903" r="8.684"/></svg>')}`;

    /** Split button in the WME toolbar: fish (runs Clean) + ▾ (opens the options). */
    function createToolbar() {
        toolbar = document.createElement('div');
        toolbar.id = `${SCRIPT_ID}-toolbar`;
        Object.assign(toolbar.style, {
            display: 'inline-flex',
            alignItems: 'center',
            height: '32px',
            margin: '0 4px',
            border: '1px solid #c0c0c0',
            borderRadius: '6px',
            background: '#fff',
            font: '13px sans-serif',
            userSelect: 'none',
            verticalAlign: 'middle',
        });

        cleanButton = document.createElement('button');
        Object.assign(cleanButton.style, BTN_STYLE, { padding: '0 8px' });
        cleanButton.addEventListener('click', runClean);
        addPressFeedback(cleanButton);

        countLabel = document.createElement('span');
        countLabel.style.marginLeft = '4px';
        const fishIcon = document.createElement('img');
        fishIcon.src = FISH_ICON_URL;
        fishIcon.alt = 'Goldfish';
        Object.assign(fishIcon.style, { width: '20px', height: '20px', verticalAlign: 'middle' });
        quotaLabel = document.createElement('span');
        Object.assign(quotaLabel.style, { marginLeft: '6px', font: '11px sans-serif' });
        cleanButton.append(fishIcon, countLabel, quotaLabel);

        toggleButton = document.createElement('button');
        Object.assign(toggleButton.style, BTN_STYLE, { padding: '0 6px', borderLeft: '1px solid #e0e0e0' });
        toggleButton.textContent = '▾';
        addPressFeedback(toggleButton);
        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            setExpanded(!expanded);
        });

        // Drag handle (double-click: puts the bar back in the WME toolbar).
        grip = document.createElement('span');
        grip.textContent = '⠿';
        grip.title = t('grip');
        Object.assign(grip.style, {
            padding: '0 4px',
            cursor: 'move',
            color: '#888',
            touchAction: 'none',
            lineHeight: '30px',
            borderRight: '1px solid #e0e0e0',
        });
        enableDrag(grip);
        grip.addEventListener('dblclick', dock);

        toolbar.append(grip, cleanButton, toggleButton);

        // Options panel (added to body so the toolbar does not clip it).
        body = document.createElement('div');
        body.id = `${SCRIPT_ID}-options`;
        Object.assign(body.style, {
            display: 'none',
            position: 'fixed',
            zIndex: 10000,
            padding: '6px 10px',
            background: '#fff',
            border: '1px solid #c0c0c0',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            font: '13px sans-serif',
            color: '#222',
        });
        body.addEventListener('click', (e) => e.stopPropagation());

        const actionDefs = ['delete', 'clean', 'roadType', 'unpaved', 'twoWay', 'geometry'];
        const prefs = loadPrefs();
        for (const key of actionDefs) {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 0', cursor: 'pointer' });
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = prefs.checked?.[key] ?? true;
            box.addEventListener('change', () => {
                savePrefs({ ...loadPrefs(), checked: Object.fromEntries(Object.entries(checkboxes).map(([k, b]) => [k, b.checked])) });
            });
            checkboxes[key] = box;
            optionLabels[key] = document.createTextNode(t(key));
            label.append(box, optionLabels[key]);
            body.appendChild(label);
        }
        document.body.appendChild(body);

        // Click elsewhere: close the options.
        document.addEventListener('click', () => setExpanded(false));
        window.addEventListener('resize', positionOptions);

        // Report of the last run (changes made + undo).
        reportPanel = document.createElement('div');
        reportPanel.id = `${SCRIPT_ID}-report`;
        Object.assign(reportPanel.style, {
            display: 'none',
            position: 'fixed',
            zIndex: 10000,
            minWidth: '220px',
            maxWidth: '420px',
            padding: '6px 10px',
            background: '#fff',
            border: '1px solid #c0c0c0',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            font: '13px sans-serif',
            color: '#222',
        });
        reportPanel.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(reportPanel);

        // Gives focus back to the map after a click: a button or checkbox that keeps focus blocks WME shortcuts.
        const releaseFocus = () => {
            const active = document.activeElement;
            if (active && active !== document.body && toolbar.contains(active)) active.blur();
        };
        toolbar.addEventListener('click', () => setTimeout(releaseFocus, 0));
        toolbar.addEventListener('change', releaseFocus);

        const { left, top } = loadPrefs();
        if (left != null && top != null) {
            floatAt(left, top, false);
        } else {
            mountToolbar();
        }
        setExpanded(false);
        window.addEventListener('resize', () => floating && floatAt(toolbar.offsetLeft, toolbar.offsetTop, false));
    }

    function loadPrefs() {
        try {
            return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
        } catch (e) {
            return {};
        }
    }

    function savePrefs(prefs) {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) {
            // storage unavailable: ignore
        }
    }

    /** Inserts the button in the WME toolbar; falls back to floating at the top left of the map if it is not found. */
    function mountToolbar() {
        const host = document.querySelector('#edit-buttons');
        if (host) {
            host.appendChild(toolbar);
            return;
        }
        console.warn(`[${SCRIPT_ID}] toolbar WME introuvable, affichage flottant`);
        floatAt(60, 60, false);
    }

    /** Detaches the bar from the WME toolbar and positions it (fixed), keeping it visible. */
    function floatAt(left, top, persist = true) {
        if (!floating) {
            floating = true;
            Object.assign(toolbar.style, { position: 'fixed', zIndex: 10000, margin: '0', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' });
            document.body.appendChild(toolbar);
        }
        const x = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - toolbar.offsetWidth));
        const y = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - toolbar.offsetHeight));
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${y}px`;
        if (persist) savePrefs({ ...loadPrefs(), left: x, top: y });
        positionOptions();
    }

    /** Puts the bar back in the WME toolbar and forgets the position. */
    function dock() {
        floating = false;
        Object.assign(toolbar.style, { position: '', zIndex: '', top: '', left: '', margin: '0 4px', boxShadow: '' });
        const { left, top, ...rest } = loadPrefs();
        savePrefs(rest);
        mountToolbar();
        positionOptions();
    }

    function enableDrag(handle) {
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const r = toolbar.getBoundingClientRect();
            const offsetX = e.clientX - r.left;
            const offsetY = e.clientY - r.top;
            handle.setPointerCapture(e.pointerId);
            const onMove = (ev) => floatAt(ev.clientX - offsetX, ev.clientY - offsetY, false);
            const onUp = (ev) => {
                handle.releasePointerCapture(ev.pointerId);
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                if (floating) floatAt(toolbar.offsetLeft, toolbar.offsetTop); // save
            };
            // First grab: freeze the current position before following the mouse.
            floatAt(r.left, r.top, false);
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    /** Places a panel below the bar, keeping it inside the window. */
    function positionBelowToolbar(panel) {
        const r = toolbar.getBoundingClientRect();
        panel.style.top = `${Math.round(r.bottom + 4)}px`;
        const left = Math.min(r.left, window.innerWidth - panel.offsetWidth - 4);
        panel.style.left = `${Math.max(4, Math.round(left))}px`;
    }

    function positionOptions() {
        positionBelowToolbar(body);
        if (reportPanel?.style.display === 'block') positionBelowToolbar(reportPanel);
    }

    function setExpanded(value) {
        expanded = value;
        if (expanded) hideReport();
        body.style.display = expanded ? 'block' : 'none';
        toggleButton.textContent = expanded ? '▴' : '▾';
        toggleButton.title = expanded ? t('optHide') : t('optShow');
        if (expanded) positionOptions();
    }

    function updateToolbar() {
        const n = shortSegments.length;
        countLabel.textContent = n === 0 ? '' : String(n);
        countLabel.style.color = '#c2185b';
        countLabel.style.fontWeight = 'bold';
        cleanButton.title = n === 0 ? t('cleanTitle') : t('cleanTitleCount', n);
        // Segment merging depends on the country: the label follows the current country.
        if (optionLabels.geometry) optionLabels.geometry.textContent = t(mergeUnsavedOnly() ? 'geometryMergeUnsaved' : 'geometry');
        updateQuotaLabel();
    }

    // ------------------------------------------------- report, undo

    /** Records a successful change of the current run (one SDK write = one action). */
    function logChange(kind, ids, extra = 0) {
        if (!runLog) return;
        const entry = runLog.get(kind) ?? { ids: [], extra: 0, actions: 0 };
        entry.ids.push(...ids);
        entry.extra += extra;
        entry.actions++;
        runLog.set(kind, entry);
    }

    const LOG_ORDER = [
        ['delete', (e) => t('logDelete', e.ids.length)],
        ['clean', (e) => t('logClean', e.ids.length)],
        ['roadType', (e) => t('logRoadType', e.ids.length)],
        ['unpaved', (e) => t('logUnpaved', e.ids.length)],
        ['twoWay', (e) => t('logTwoWay', e.ids.length)],
        ['merge', (e) => t('logMerge', e.actions)],
        ['geometry', (e) => t('logGeometry', e.ids.length, e.extra)],
    ];

    function hideReport() {
        if (reportPanel) reportPanel.style.display = 'none';
    }

    /** Selects those segments that still exist (deleted or merged ones are ignored). */
    async function selectSegments(ids) {
        const existing = [];
        for (const id of new Set(ids)) {
            if (await sdk.DataModel.Segments.getById({ segmentId: id })) existing.push(id);
        }
        if (existing.length === 0) return;
        try {
            await sdk.Editing.setSelection({ selection: { ids: existing, objectType: 'segment' } });
        } catch (e) {
            console.warn(`[${SCRIPT_ID}] sélection impossible`, e);
        }
    }

    /** Shows below the bar the list of changes of the last run, with an Undo button. */
    function showReport(log, stopped) {
        setExpanded(false);
        reportPanel.replaceChildren();
        const title = document.createElement('div');
        title.textContent = t('reportTitle');
        Object.assign(title.style, { fontWeight: 'bold', marginBottom: '4px' });
        reportPanel.appendChild(title);

        const list = document.createElement('ul');
        Object.assign(list.style, { margin: '0', padding: '0 0 0 18px' });
        for (const [kind, format] of LOG_ORDER) {
            const entry = log.get(kind);
            if (!entry) continue;
            const item = document.createElement('li');
            item.textContent = format(entry);
            item.title = `${t('reportSelect')}\n${[...new Set(entry.ids)].join(', ')}`;
            Object.assign(item.style, { cursor: 'pointer', margin: '2px 0' });
            item.addEventListener('click', () => selectSegments(entry.ids));
            list.appendChild(item);
        }
        if (list.children.length) {
            reportPanel.appendChild(list);
        } else {
            const none = document.createElement('div');
            none.textContent = t('reportNone');
            none.style.color = '#888';
            reportPanel.appendChild(none);
        }
        if (stopped) {
            const warn = document.createElement('div');
            warn.textContent = t('reportStopped');
            Object.assign(warn.style, { color: '#c62828', marginTop: '4px' });
            reportPanel.appendChild(warn);
        }

        const buttons = document.createElement('div');
        Object.assign(buttons.style, { display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '6px' });
        const makeButton = (label, onClick) => {
            const b = document.createElement('button');
            b.textContent = label;
            Object.assign(b.style, BTN_STYLE, { height: '26px', padding: '0 10px', border: '1px solid #c0c0c0', borderRadius: '4px' });
            addPressFeedback(b);
            b.addEventListener('click', onClick);
            return b;
        };
        if (lastRun) buttons.appendChild(makeButton(t('undo'), undoLastRun));
        buttons.appendChild(makeButton(t('close'), hideReport));
        reportPanel.appendChild(buttons);

        reportPanel.style.display = 'block';
        positionBelowToolbar(reportPanel);
    }

    /**
     * Undoes the last Clean run via WME's undo, only if the map has not been
     * modified since (otherwise the user's own edits would be undone).
     */
    async function undoLastRun() {
        const run = lastRun;
        if (!run) return;
        hideReport();
        if (await sdk.Editing.getUnsavedChangesCount() !== run.afterCount) {
            lastRun = null;
            showToast(t('undoStale'), 6000);
            return;
        }
        // WME's counter gives the exact number of added actions; fall back to our own count.
        const delta = run.afterCount - run.beforeCount;
        const count = delta > 0 ? delta : run.actions;
        let undone = 0;
        cleanRunning = true; // no move to the quota log during the undo
        try {
            for (let i = 0; i < count; i++) {
                await sdk.Editing.undo();
                undone++;
            }
        } catch (e) {
            console.warn(`[${SCRIPT_ID}] annulation interrompue après ${undone} action(s)`, e);
        } finally {
            // Undone edits will not be saved: they no longer count toward the cap.
            if (undone === count) {
                const pending = pendingEdits.get(run.countryKey);
                for (const k of run.freshKeys) pending?.delete(k);
            }
            cleanRunning = false;
            lastRun = null;
        }
        showToast(undone === count ? t('undoDone', undone) : t('undoFailed'), undone === count ? 2500 : 6000);
        updateQuotaLabel();
        await refresh();
    }

    // ------------------------------------------------------- deletion

    async function deleteShortSegments() {
        // Recompute so as not to delete based on a stale state.
        const targets = await findShortSegments();
        let deleted = 0;
        for (const { id } of targets) {
            // An unsaved segment (negative id) does not exist server-side: deleting it does not count.
            if (id >= 0 && !reserveEdits([`s${id}`])) break;
            try {
                await sdk.DataModel.Segments.deleteSegment({ segmentId: id });
                logChange('delete', [id]);
                deleted++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] suppression impossible du segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${deleted}/${targets.length} segment(s) supprimé(s)`);
    }

    // ------------------------------------------------------------ clean

    /** Unnamed street in an unnamed city (created if needed). */
    async function getEmptyStreetId() {
        const countryId = (await sdk.DataModel.Countries.getTopCountry()).id;
        const city = sdk.DataModel.Cities.getCity({ cityName: '', countryId })
            ?? sdk.DataModel.Cities.addCity({ cityName: '', countryId });
        const cityId = (await city).id;
        const street = sdk.DataModel.Streets.getStreet({ streetName: '', cityId })
            ?? sdk.DataModel.Streets.addStreet({ streetName: '', cityId });
        return (await street).id;
    }

    async function cleanNewSegments() {
        // Unsaved segments only (negative id): an existing segment keeps its name and city.
        const targets = (await sdk.DataModel.Segments.getAll()).filter((s) => s.id < 0).map((s) => ({ id: s.id }));
        if (targets.length === 0) {
            console.log(`[${SCRIPT_ID}] clean : aucun segment non enregistré`);
            return;
        }
        const streetId = await getEmptyStreetId();
        let cleaned = 0;
        for (const { id } of targets) {
            try {
                const segment = await sdk.DataModel.Segments.getById({ segmentId: id });
                if (segment?.primaryStreetId !== streetId) {
                    if (!reserveEdits([`s${id}`])) break;
                    await sdk.DataModel.Segments.updateAddress({ segmentId: id, addressData: { primaryStreetId: streetId } });
                    logChange('clean', [id]);
                }
                cleaned++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] nettoyage impossible du segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${cleaned}/${targets.length} segment(s) nettoyé(s)`);
    }

    /** Unsaved segments (negative id) only: an existing segment is never modified here. */
    async function getUnsavedIds() {
        return (await sdk.DataModel.Segments.getAll()).filter((s) => s.id < 0).map((s) => s.id);
    }

    /** Applies `apply(segment, id)` to each unsaved segment; `apply` returns false if there is nothing to do. */
    async function updateUnsaved(label, apply) {
        const ids = await getUnsavedIds();
        let done = 0;
        for (const id of ids) {
            if (quotaBlocked) break;
            try {
                const segment = await sdk.DataModel.Segments.getById({ segmentId: id });
                if (segment && (await apply(segment, id)) !== false) done++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] ${label} impossible pour le segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${label} : ${done}/${ids.length} segment(s) modifié(s)`);
    }

    function setRoadTypeStreet() {
        // updateSegment fails (InvalidStateError) when nothing changes: avoid it.
        return updateUnsaved('type Street', async (segment, id) => {
            if (segment.roadType === STREET_ROAD_TYPE) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateSegment({ segmentId: id, roadType: STREET_ROAD_TYPE });
            logChange('roadType', [id]);
        });
    }

    function removeUnpaved() {
        return updateUnsaved('non bitumé', async (segment, id) => {
            if (!segment.flagAttributes?.unpaved) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateSegment({ segmentId: id, flagAttributes: { unpaved: false } });
            logChange('unpaved', [id]);
        });
    }

    function setTwoWay() {
        return updateUnsaved('double sens', async (segment, id) => {
            if (segment.isTwoWay) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateDirection({ segmentId: id, direction: 'TWO_WAY' });
            logChange('twoWay', [id]);
        });
    }

    /** Runs the checked actions, in order. */
    async function runClean() {
        cleanButton.disabled = true;
        cleanButton.style.opacity = '0.5'; // run in progress
        cleanButton.style.transform = 'none';
        // Country of the action (hourly cap): re-read at launch, the map may have moved.
        quotaBlocked = false;
        cleanRunning = true;
        hideReport();
        await refreshCountry();
        updateQuotaLabel();
        // State before the run, to be able to undo exactly what Clean did.
        runLog = new Map();
        const countryKey = currentCountry.key;
        const pendingBefore = new Set(pendingEdits.get(countryKey) ?? []);
        const beforeCount = await sdk.Editing.getUnsavedChangesCount();
        const steps = [
            ['delete', deleteShortSegments],
            ['clean', cleanNewSegments],
            ['roadType', setRoadTypeStreet],
            ['unpaved', removeUnpaved],
            ['twoWay', setTwoWay],
            ['geometry', simplifyGeometry],
        ];
        try {
            for (const [key, fn] of steps) {
                if (!checkboxes[key].checked) continue;
                if (quotaBlocked) break; // cap reached: do not chain the next steps
                try {
                    await fn();
                } catch (e) {
                    console.error(`[${SCRIPT_ID}] erreur (${key})`, e);
                }
            }
        } finally {
            const log = runLog;
            runLog = null;
            try {
                const afterCount = await sdk.Editing.getUnsavedChangesCount();
                const actions = [...log.values()].reduce((sum, e) => sum + e.actions, 0);
                const freshKeys = [...(pendingEdits.get(countryKey) ?? [])].filter((k) => !pendingBefore.has(k));
                lastRun = actions > 0 ? { log, beforeCount, afterCount, actions, countryKey, freshKeys } : null;
                showReport(log, quotaBlocked);
            } catch (e) {
                console.error(`[${SCRIPT_ID}] erreur du rapport`, e);
            }
            cleanRunning = false;
            cleanButton.blur();
            cleanButton.disabled = false;
            cleanButton.style.opacity = '1';
            cleanButton.style.background = 'transparent';
            await refresh();
        }
    }

    // ------------------------------------------------------- target

    /**
     * Target segments: the selection if there is one, otherwise all visible segments
     * (loaded in the current map extent). Returns a Map id -> segment.
     */
    async function getTargetSegments() {
        const targets = new Map();
        const selection = await sdk.Editing.getSelection();
        if (selection && String(selection.objectType).toLowerCase() === 'segment' && selection.ids?.length) {
            for (const id of selection.ids) {
                const segment = await sdk.DataModel.Segments.getById({ segmentId: id });
                if (segment) targets.set(id, segment);
            }
            return targets;
        }
        return getVisibleSegments();
    }

    /** All loaded segments with a part inside the map extent (ignoring the selection). */
    async function getVisibleSegments() {
        const targets = new Map();
        let extent = null;
        try {
            extent = await sdk.Map.getMapExtent(); // [minLon, minLat, maxLon, maxLat]
        } catch (e) { /* no extent: take all loaded segments */ }
        for (const segment of await sdk.DataModel.Segments.getAll()) {
            if (extent && !segment.geometry.coordinates.some(([lon, lat]) =>
                lon >= extent[0] && lon <= extent[2] && lat >= extent[1] && lat <= extent[3])) continue;
            targets.set(segment.id, segment);
        }
        return targets;
    }

    // ----------------------------------------------- Douglas-Peucker

    /** Distance (m) from a point to the segment [a, b], in a local planar frame. */
    function pointToSegmentDist(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    /**
     * Douglas-Peucker on a list of GeoJSON positions [lon, lat].
     * Distances are computed in meters (local equirectangular projection);
     * the end points are always kept.
     */
    function douglasPeucker(coords, epsilonM) {
        // A single pass is not idempotent (chords change once points are removed):
        // repeat until a fixed point so that applying it again changes nothing.
        let current = coords;
        for (;;) {
            const next = douglasPeuckerPass(current, epsilonM);
            if (next.length === current.length) return current;
            current = next;
        }
    }

    function douglasPeuckerPass(coords, epsilonM) {
        if (coords.length < 3) return coords;
        const rad = Math.PI / 180;
        const lat0 = coords[0][1] * rad;
        const pts = coords.map(([lon, lat]) => ({
            x: lon * rad * Math.cos(lat0) * EARTH_RADIUS_M,
            y: lat * rad * EARTH_RADIUS_M,
        }));
        const keep = new Array(coords.length).fill(false);
        keep[0] = keep[coords.length - 1] = true;
        const stack = [[0, coords.length - 1]];
        while (stack.length) {
            const [first, last] = stack.pop();
            let maxD = 0;
            let idx = -1;
            for (let i = first + 1; i < last; i++) {
                const d = pointToSegmentDist(pts[i], pts[first], pts[last]);
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (idx !== -1 && maxD > epsilonM) {
                keep[idx] = true;
                stack.push([first, idx], [idx, last]);
            }
        }
        return coords.filter((_, i) => keep[i]);
    }

    /** Shows a transient message at the bottom of the screen, which disappears on its own after `durationMs`. */
    function showToast(text, durationMs = 2500) {
        const toast = document.createElement('div');
        toast.textContent = text;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10001, padding: '8px 16px', borderRadius: '6px',
            background: 'rgba(0,0,0,0.8)', color: '#fff', font: '13px sans-serif',
            pointerEvents: 'none', opacity: '0', transition: 'opacity 0.3s',
        });
        Object.assign(toast.style, { position: 'static', transform: 'none', margin: '4px 0' });
        let stack = document.getElementById(`${SCRIPT_ID}-toasts`);
        if (!stack) {
            stack = document.createElement('div');
            stack.id = `${SCRIPT_ID}-toasts`;
            Object.assign(stack.style, {
                position: 'fixed', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
                zIndex: 10001, display: 'flex', flexDirection: 'column', alignItems: 'center',
                pointerEvents: 'none',
            });
            document.body.appendChild(stack);
        }
        stack.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; });
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, durationMs);
    }

    /**
     * Merges segments joined by a "useless" node: a node with exactly 2 segments,
     * same road type, same street (name and city), compatible directions, same speed limits,
     * same "unpaved" option and same restrictions. In some countries (France), limited to unsaved segments (negative id). Returns the number of segments removed by merging.
     */
    async function mergeUselessNodes(targets) {
        let total = 0;
        // Target stable from one pass to the next: the selection may be lost after a merge.
        // So we track the starting ids, plus the ids created by merges (absent from the initial state).
        const initialVisible = new Set((await getVisibleSegments()).keys());
        const targetIds = new Set(targets.keys());
        const unsavedOnly = mergeUnsavedOnly();
        // mergeSegments refuses groups of more than 2 segments: merge two at a time,
        // then re-read the data (ids change) until there is nothing left to merge.
        for (let pass = 0; pass < 20; pass++) {
            const visible = await getVisibleSegments();
            const current = new Map();
            for (const [id, seg] of visible) {
                // In the affected countries, only unsaved segments (negative id) can be merged.
                if (unsavedOnly && id >= 0) continue;
                if ((targetIds.has(id) || !initialVisible.has(id))) current.set(id, seg);
            }
            const n = await mergePass(current);
            if (n === 0 || quotaBlocked) break;
            total += n;
        }
        return total;
    }

    /** One pass: merges disjoint pairs of segments. Returns the number of successful merges. */
    async function mergePass(segments) {
        const known = new Map(segments);
        const getSeg = async (id) => {
            if (!known.has(id)) known.set(id, await sdk.DataModel.Segments.getById({ segmentId: id }));
            return known.get(id);
        };

        // Direction of the segment seen from a node: 'both', 'in' (arrives at the node) or 'out' (leaves the node).
        const dirAt = (seg, nodeId) => {
            if (seg.isTwoWay) return 'both';
            const toward = nodeId === seg.toNodeId;
            return seg.isAtoB === toward ? 'in' : 'out';
        };

        const pairs = [];
        const used = new Set();
        const seen = new Set();
        for (const segment of segments.values()) {
            for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
                if (nodeId == null || seen.has(nodeId)) continue;
                seen.add(nodeId);
                const node = await sdk.DataModel.Nodes.getById({ nodeId });
                const ids = node?.connectedSegmentIds ?? [];
                if (ids.length !== 2) continue;
                if (!ids.every((id) => segments.has(id))) continue; // both segments must be in the target
                if (ids.some((id) => used.has(id))) continue;
                const [a, b] = await Promise.all(ids.map(getSeg));
                if (!a || !b || a.id === b.id) continue;
                if (a.roadType !== b.roadType || a.primaryStreetId !== b.primaryStreetId) continue;
                if (Boolean(a.isTwoWay) !== Boolean(b.isTwoWay)) continue;
                if (!a.isTwoWay && dirAt(a, nodeId) === dirAt(b, nodeId)) continue; // incompatible one-way directions
                if (Boolean(a.flagAttributes?.unpaved) !== Boolean(b.flagAttributes?.unpaved)) continue;
                if (JSON.stringify(a.restrictions ?? []) !== JSON.stringify(b.restrictions ?? [])) continue;
                // Speed limits: compared in each travel direction through the node.
                const speedIn = (s) => (nodeId === s.toNodeId ? s.fwdSpeedLimit : s.revSpeedLimit);
                const speedOut = (s) => (nodeId === s.fromNodeId ? s.fwdSpeedLimit : s.revSpeedLimit);
                if ((speedIn(a) ?? null) !== (speedOut(b) ?? null)) continue;
                if ((speedOut(a) ?? null) !== (speedIn(b) ?? null)) continue;
                if (a.fromNodeId === b.fromNodeId && a.toNodeId === b.toNodeId) continue; // loop
                used.add(a.id);
                used.add(b.id);
                pairs.push([a.id, b.id]);
            }
        }

        let merged = 0;
        for (const ids of pairs) {
            // A merge touches the two original segments and creates a new one (dummy key: its id is unknown).
            if (!reserveEdits([...ids.map((id) => `s${id}`), `merge-${Date.now()}-${merged}`])) break;
            try {
                await sdk.DataModel.Segments.mergeSegments({ segmentIds: ids });
                logChange('merge', ids);
                merged++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] fusion impossible des segments ${ids.join(', ')}`, e);
                showToast(t('mergeFailed', e?.message ?? e), 6000);
            }
        }
        return merged;
    }

    /** Reduces the shape points of the target segments (selection, otherwise visible) without moving their end points. */
    async function simplifyGeometry() {
        try {
            let segments = await getTargetSegments();
            const merged = await mergeUselessNodes(segments);
            if (merged > 0) segments = await getTargetSegments(); // ids changed after merging
            let removed = 0;
            for (const [id, segment] of segments) {
                const coords = segment.geometry.coordinates;
                const simplified = douglasPeucker(coords, DP_EPSILON_M);
                if (simplified.length === coords.length) continue;
                if (!reserveEdits([`s${id}`])) break;
                try {
                    await sdk.DataModel.Segments.updateSegment({
                        segmentId: id,
                        geometry: { type: 'LineString', coordinates: simplified },
                    });
                    removed += coords.length - simplified.length;
                    logChange('geometry', [id], coords.length - simplified.length);
                } catch (e) {
                    console.warn(`[${SCRIPT_ID}] simplification impossible du segment ${id}`, e);
                }
            }
            console.log(`[${SCRIPT_ID}] simplify geometry : ${removed} point(s) de forme supprimé(s), ${merged} nœud(s) inutile(s) fusionné(s)`);
        } catch (e) {
            console.error(`[${SCRIPT_ID}] erreur de simplification de géométrie`, e);
        }
    }

    // ---------------------------------------------------------- refresh

    async function refresh() {
        // Avoids concurrent runs; a request received during a refresh triggers another one.
        if (refreshing) {
            refreshAgain = true;
            return;
        }
        refreshing = true;
        try {
            do {
                refreshAgain = false;
                await refreshCountry();
                // No unsaved change left: everything was undone, nothing to count.
                if (!cleanRunning && await sdk.Editing.getUnsavedChangesCount() === 0) discardPendingEdits();
                shortSegments = await findShortSegments();
                unconnectedNodes = await findUnconnectedNodes();
                await drawHighlights();
                updateToolbar();
            } while (refreshAgain);
        } catch (e) {
            console.error(`[${SCRIPT_ID}] erreur de rafraîchissement`, e);
        } finally {
            refreshing = false;
        }
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
    }

    function registerEvents() {
        sdk.Events.trackDataModelEvents({ dataModelName: 'segments' });

        sdk.Events.on({
            eventName: 'wme-data-model-objects-changed',
            eventHandler: ({ dataModelName }) => {
                if (dataModelName === 'segments') scheduleRefresh();
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-added',
            eventHandler: ({ dataModelName, objectIds }) => {
                // Segments loaded from the server have a positive id: only new ones matter.
                if (dataModelName === 'segments' && objectIds.some((id) => id < 0)) scheduleRefresh();
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-removed',
            eventHandler: ({ dataModelName }) => {
                if (dataModelName === 'segments') scheduleRefresh();
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-saved',
            eventHandler: ({ dataModelName }) => {
                if (dataModelName !== 'segments') return;
                commitPendingEdits();
                // Saved: nothing left to undo on Goldfish's side.
                lastRun = null;
                hideReport();
                scheduleRefresh();
            },
        });

        for (const eventName of ['wme-after-edit', 'wme-after-undo', 'wme-after-redo-clear', 'wme-map-data-loaded']) {
            sdk.Events.on({ eventName, eventHandler: scheduleRefresh });
        }
    }
})();
