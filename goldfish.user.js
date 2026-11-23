// ==UserScript==
// @name         WME Goldfish - Segments < 1m
// @namespace    https://github.com/kpouer/wme-goldfish
// @version      0.6.0
// @description  Met en surbrillance les segments en cours de modification qui font moins de 1 m et permet de les nettoyer depuis un bouton de la toolbar.
// @author       kpouer
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @grant        none
// ==/UserScript==

/* global getWmeSdk */

(function () {
    'use strict';

    const SCRIPT_ID = 'wme-goldfish';
    const SCRIPT_NAME = 'Goldfish';
    const LAYER_NAME = 'goldfish-short-segments';
    const UNCONNECTED_LAYER_NAME = 'goldfish-unconnected-segments';
    const MAX_LENGTH_M = 1;        // segments strictement inférieurs à 1 m
    const REFRESH_DELAY_MS = 250;  // debounce du rafraîchissement
    const STREET_ROAD_TYPE = 1;    // id WME du type "Street"
    const EARTH_RADIUS_M = 6371008.8;
    const DP_EPSILON_M = 1;        // tolérance Douglas-Peucker en mètres
    const PREFS_KEY = `${SCRIPT_ID}-prefs`;

    /** @type {import('wme-sdk-typings').WmeSDK} */
    let sdk;
    let toolbar;
    let body;
    let countLabel;
    let cleanButton;
    const checkboxes = {};
    let toggleButton;
    let expanded = false;
    let floating = false;
    let grip;
    let refreshTimer = null;
    let refreshing = false;
    let refreshAgain = false;

    /** Ids des segments touchés depuis le dernier enregistrement (le SDK n'expose pas d'état "modifié"). */
    const editedIds = new Set();
    /** Résultat courant : [{ id, length }] */
    let shortSegments = [];
    /** Nœuds non connectés des nouveaux segments */
    let unconnectedNodes = [];

    // ---------------------------------------------------------------- init

    window.SDK_INITIALIZED.then(() => {
        sdk = getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: 'async' });
        sdk.Events.once({ eventName: 'wme-ready' }).then(init);
    });

    async function init() {
        await sdk.Map.addLayer({
            layerName: LAYER_NAME,
            styleRules: [{
                style: {
                    strokeColor: '#ff00ff',
                    strokeOpacity: 0.9,
                    strokeWidth: 12,
                    fillColor: '#ff00ff',
                    fillOpacity: 0.6,
                    pointRadius: 10,
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
        createToolbar();
        registerEvents();
        await refresh();
        console.log(`[${SCRIPT_ID}] chargé`);
    }

    // --------------------------------------------------------- détection

    /** Distance haversine en mètres entre deux positions GeoJSON [lon, lat]. */
    function haversine([lon1, lat1], [lon2, lat2]) {
        const rad = Math.PI / 180;
        const dLat = (lat2 - lat1) * rad;
        const dLon = (lon2 - lon1) * rad;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
    }

    /** Longueur en mètres d'une LineString GeoJSON (lon/lat WGS84). */
    function lineLength(geometry) {
        const c = geometry.coordinates;
        let total = 0;
        for (let i = 1; i < c.length; i++) total += haversine(c[i - 1], c[i]);
        return total;
    }

    /** Nouveau segment (id négatif) ou segment touché depuis le dernier enregistrement. */
    function isBeingEdited(segment) {
        return segment.id < 0 || editedIds.has(segment.id);
    }

    async function findShortSegments() {
        // Plus aucune modification en attente : rien n'est "en cours de modification".
        if (await sdk.Editing.getUnsavedChangesCount() === 0) {
            editedIds.clear();
            return [];
        }
        const segments = await sdk.DataModel.Segments.getAll();
        const result = [];
        for (const segment of segments) {
            if (!isBeingEdited(segment)) continue;
            const length = lineLength(segment.geometry);
            if (length < MAX_LENGTH_M) result.push({ id: segment.id, length, geometry: segment.geometry });
        }
        return result;
    }

    /** Nœuds des nouveaux segments (id négatif) qui ne sont reliés à aucun autre segment. */
    async function findUnconnectedNodes() {
        const nodes = new Map();
        for (const segment of await sdk.DataModel.Segments.getAll()) {
            if (segment.id >= 0) continue;
            for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
                if (nodeId == null || nodes.has(nodeId)) continue;
                const node = await sdk.DataModel.Nodes.getById({ nodeId });
                if (!node) continue;
                const others = (node.connectedSegmentIds ?? []).filter((id) => id !== segment.id);
                if (others.length === 0) nodes.set(nodeId, node);
            }
        }
        console.log(`[${SCRIPT_ID}] noeuds non connectés : ${nodes.size}`);
        return [...nodes.values()];
    }

    // ------------------------------------------------------ surbrillance

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
                feature: { type: 'Feature', id: `goldfish-${id}`, geometry, properties: { segmentId: id } },
            });
        }
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

    /** Bouton « split » dans la toolbar de WME : 🐟 (exécute Clean) + ▾ (ouvre les options). */
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

        countLabel = document.createElement('span');
        countLabel.style.marginLeft = '4px';
        cleanButton.append('🐟', countLabel);

        toggleButton = document.createElement('button');
        Object.assign(toggleButton.style, BTN_STYLE, { padding: '0 6px', borderLeft: '1px solid #e0e0e0' });
        toggleButton.textContent = '▾';
        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            setExpanded(!expanded);
        });

        // Poignée de déplacement (double-clic : remet la barre dans la toolbar de WME).
        grip = document.createElement('span');
        grip.textContent = '⠿';
        grip.title = 'Déplacer (double-clic : réinitialiser)';
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

        // Panneau d'options (ajouté au body pour ne pas être rogné par la toolbar).
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

        const actionDefs = [
            ['delete', 'Supprimer les segments < 1 m'],
            ['clean', 'Nettoyer les nouveaux segments (sans nom, sans ville, Street)'],
            ['simplify', 'Simplify (nœuds en trop, sélection)'],
            ['geometry', 'Simplify geometry (points de forme, sélection)'],
        ];
        const prefs = loadPrefs();
        for (const [key, text] of actionDefs) {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 0', cursor: 'pointer' });
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = prefs.checked?.[key] ?? true;
            box.addEventListener('change', () => {
                savePrefs({ ...loadPrefs(), checked: Object.fromEntries(Object.entries(checkboxes).map(([k, b]) => [k, b.checked])) });
            });
            checkboxes[key] = box;
            label.append(box, document.createTextNode(text));
            body.appendChild(label);
        }
        document.body.appendChild(body);

        // Clic ailleurs : on referme les options.
        document.addEventListener('click', () => setExpanded(false));
        window.addEventListener('resize', () => expanded && positionOptions());

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
            // stockage indisponible : on ignore
        }
    }

    /** Insère le bouton dans la toolbar de WME ; repli en haut à gauche de la carte si elle est introuvable. */
    function mountToolbar() {
        const host = document.querySelector('#edit-buttons');
        if (host) {
            host.appendChild(toolbar);
            return;
        }
        console.warn(`[${SCRIPT_ID}] toolbar WME introuvable, affichage flottant`);
        floatAt(60, 60, false);
    }

    /** Détache la barre de la toolbar WME et la positionne (fixe), en la gardant visible. */
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
        if (expanded) positionOptions();
    }

    /** Remet la barre dans la toolbar WME et oublie la position. */
    function dock() {
        floating = false;
        Object.assign(toolbar.style, { position: '', zIndex: '', top: '', left: '', margin: '0 4px', boxShadow: '' });
        const { left, top, ...rest } = loadPrefs();
        savePrefs(rest);
        mountToolbar();
        if (expanded) positionOptions();
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
                if (floating) floatAt(toolbar.offsetLeft, toolbar.offsetTop); // sauvegarde
            };
            // Première prise : on fige la position actuelle avant de suivre la souris.
            floatAt(r.left, r.top, false);
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    function positionOptions() {
        const r = toolbar.getBoundingClientRect();
        body.style.top = `${Math.round(r.bottom + 4)}px`;
        const left = Math.min(r.left, window.innerWidth - body.offsetWidth - 4);
        body.style.left = `${Math.max(4, Math.round(left))}px`;
    }

    function setExpanded(value) {
        expanded = value;
        body.style.display = expanded ? 'block' : 'none';
        toggleButton.textContent = expanded ? '▴' : '▾';
        toggleButton.title = expanded ? 'Masquer les options' : 'Options';
        if (expanded) positionOptions();
    }

    function updateToolbar() {
        const n = shortSegments.length;
        countLabel.textContent = n === 0 ? '' : String(n);
        countLabel.style.color = '#c2185b';
        countLabel.style.fontWeight = 'bold';
        cleanButton.title = n === 0
            ? 'Clean : exécute les actions cochées'
            : `Clean : exécute les actions cochées (${n} segment${n > 1 ? 's' : ''} < 1 m)`;
    }

    // ------------------------------------------------------- suppression

    async function deleteShortSegments() {
        // Recalcul pour ne pas supprimer sur la base d'un état périmé.
        const targets = await findShortSegments();
        let deleted = 0;
        for (const { id } of targets) {
            try {
                await sdk.DataModel.Segments.deleteSegment({ segmentId: id });
                deleted++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] suppression impossible du segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${deleted}/${targets.length} segment(s) supprimé(s)`);
    }

    // ------------------------------------------------------------ clean

    /** Rue sans nom dans une ville sans nom (créées si besoin). */
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
        const targets = (await sdk.DataModel.Segments.getAll()).filter((s) => s.id < 0);
        if (targets.length === 0) return;
        const streetId = await getEmptyStreetId();
        let cleaned = 0;
        for (const { id } of targets) {
            try {
                await sdk.DataModel.Segments.updateAddress({ segmentId: id, primaryStreetId: streetId });
                await sdk.DataModel.Segments.updateSegment({ segmentId: id, roadType: STREET_ROAD_TYPE });
                cleaned++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] nettoyage impossible du segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${cleaned}/${targets.length} segment(s) nettoyé(s)`);
    }

    /** Exécute les actions cochées, dans l'ordre. */
    async function runClean() {
        cleanButton.disabled = true;
        const steps = [
            ['delete', deleteShortSegments],
            ['clean', cleanNewSegments],
            ['simplify', simplifySelection],
            ['geometry', simplifyGeometry],
        ];
        try {
            for (const [key, fn] of steps) {
                if (!checkboxes[key].checked) continue;
                try {
                    await fn();
                } catch (e) {
                    console.error(`[${SCRIPT_ID}] erreur (${key})`, e);
                }
            }
        } finally {
            cleanButton.disabled = false;
            await refresh();
        }
    }

    // --------------------------------------------------------- simplify

    async function streetNameOf(segment) {
        if (segment.primaryStreetId == null) return '';
        const street = await sdk.DataModel.Streets.getById({ streetId: segment.primaryStreetId });
        return street?.name ?? '';
    }

    /**
     * Fusionne les segments sélectionnés reliés par un nœud « en trop » :
     * nœud relié à exactement 2 segments (tous deux sélectionnés) de même type et même nom.
     */
    async function simplifySelection() {
        try {
            const selection = sdk.Editing.getSelection();
            if (!selection || String(selection.objectType).toLowerCase() !== 'segment') {
                console.log(`[${SCRIPT_ID}] simplify : aucun segment sélectionné`);
                return;
            }
            const selected = new Set(selection.ids);
            const segments = new Map();
            for (const id of selected) {
                const segment = await sdk.DataModel.Segments.getById({ segmentId: id });
                if (segment) segments.set(id, segment);
            }

            // Union-find sur les segments à fusionner.
            const parent = new Map([...segments.keys()].map((id) => [id, id]));
            const find = (id) => {
                while (parent.get(id) !== id) id = parent.get(id);
                return id;
            };

            const checked = new Set();
            for (const segment of segments.values()) {
                for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
                    if (nodeId == null || checked.has(nodeId)) continue;
                    checked.add(nodeId);
                    const node = await sdk.DataModel.Nodes.getById({ nodeId });
                    const ids = node?.connectedSegmentIds ?? [];
                    const skip = (why) => console.log(`[${SCRIPT_ID}] simplify : nœud ${nodeId} ignoré (${why})`, ids);
                    if (ids.length !== 2 || ids[0] === ids[1]) { skip(`${ids.length} segment(s) relié(s)`); continue; }
                    const [a, b] = ids.map((id) => segments.get(id));
                    if (!a || !b) { skip('segment non sélectionné'); continue; } // les deux segments doivent être sélectionnés
                    if (a.roadType !== b.roadType) { skip(`types différents ${a.roadType}/${b.roadType}`); continue; }
                    const [na, nb] = [await streetNameOf(a), await streetNameOf(b)];
                    if (na !== nb) { skip(`noms différents « ${na} » / « ${nb} »`); continue; }
                    parent.set(find(a.id), find(b.id));
                }
            }

            const groups = new Map();
            for (const id of segments.keys()) {
                const root = find(id);
                if (!groups.has(root)) groups.set(root, []);
                groups.get(root).push(id);
            }

            let merged = 0;
            for (const segmentIds of groups.values()) {
                if (segmentIds.length < 2) continue;
                try {
                    sdk.DataModel.Segments.mergeSegments({ segmentIds });
                    merged += segmentIds.length - 1;
                } catch (e) {
                    console.warn(`[${SCRIPT_ID}] fusion impossible pour les segments ${segmentIds}`, e);
                }
            }
            console.log(`[${SCRIPT_ID}] simplify : ${merged} nœud(s) supprimé(s)`);
        } catch (e) {
            console.error(`[${SCRIPT_ID}] erreur de simplification`, e);
        }
    }

    // ----------------------------------------------- Douglas-Peucker

    /** Distance (m) d'un point au segment [a, b], en repère plan local. */
    function pointToSegmentDist(p, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    /**
     * Douglas-Peucker sur une liste de positions GeoJSON [lon, lat].
     * Les distances sont calculées en mètres (projection équirectangulaire locale) ;
     * les extrémités sont toujours conservées.
     */
    function douglasPeucker(coords, epsilonM) {
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

    /** Réduit les points de forme des segments sélectionnés sans déplacer leurs extrémités. */
    async function simplifyGeometry() {
        try {
            const selection = sdk.Editing.getSelection();
            if (!selection || String(selection.objectType).toLowerCase() !== 'segment') {
                console.log(`[${SCRIPT_ID}] simplify geometry : aucun segment sélectionné`);
                return;
            }
            let removed = 0;
            for (const id of selection.ids) {
                const segment = await sdk.DataModel.Segments.getById({ segmentId: id });
                if (!segment) continue;
                const coords = segment.geometry.coordinates;
                const simplified = douglasPeucker(coords, DP_EPSILON_M);
                if (simplified.length === coords.length) continue;
                try {
                    await sdk.DataModel.Segments.updateSegment({
                        segmentId: id,
                        geometry: { type: 'LineString', coordinates: simplified },
                    });
                    removed += coords.length - simplified.length;
                } catch (e) {
                    console.warn(`[${SCRIPT_ID}] simplification impossible du segment ${id}`, e);
                }
            }
            console.log(`[${SCRIPT_ID}] simplify geometry : ${removed} point(s) de forme supprimé(s)`);
        } catch (e) {
            console.error(`[${SCRIPT_ID}] erreur de simplification de géométrie`, e);
        }
    }

    // ---------------------------------------------------------- refresh

    async function refresh() {
        // Évite les exécutions concurrentes ; une demande reçue pendant un refresh en relance un.
        if (refreshing) {
            refreshAgain = true;
            return;
        }
        refreshing = true;
        try {
            do {
                refreshAgain = false;
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

        const track = (ids) => {
            for (const id of ids) editedIds.add(id);
            scheduleRefresh();
        };

        sdk.Events.on({
            eventName: 'wme-data-model-objects-changed',
            eventHandler: ({ dataModelName, objectIds }) => {
                if (dataModelName === 'segments') track(objectIds);
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-added',
            eventHandler: ({ dataModelName, objectIds }) => {
                // Les segments chargés depuis le serveur ont un id positif : seuls les nouveaux comptent.
                if (dataModelName === 'segments') track(objectIds.filter((id) => id < 0));
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-removed',
            eventHandler: ({ dataModelName, objectIds }) => {
                if (dataModelName !== 'segments') return;
                for (const id of objectIds) editedIds.delete(id);
                scheduleRefresh();
            },
        });
        sdk.Events.on({
            eventName: 'wme-data-model-objects-saved',
            eventHandler: ({ dataModelName }) => {
                if (dataModelName !== 'segments') return;
                editedIds.clear();
                scheduleRefresh();
            },
        });

        for (const eventName of ['wme-after-edit', 'wme-after-undo', 'wme-after-redo-clear', 'wme-map-data-loaded']) {
            sdk.Events.on({ eventName, eventHandler: scheduleRefresh });
        }
    }
})();
