// ==UserScript==
// @name         WME Goldfish
// @namespace    https://github.com/kpouer/wme-goldfish
// @version      0.11.0
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
    const NEAR_DISTANCE_M = 20;    // un nœud non connecté n'est signalé que si un segment est plus proche
    const MAX_LENGTH_M = 1;        // segments strictement inférieurs à 1 m
    const REFRESH_DELAY_MS = 250;  // debounce du rafraîchissement
    const STREET_ROAD_TYPE = 1;    // id WME du type "Street"
    const EARTH_RADIUS_M = 6371008.8;
    const DP_EPSILON_M = 1;        // tolérance Douglas-Peucker en mètres
    const PREFS_KEY = `${SCRIPT_ID}-prefs`;
    const QUOTA_KEY = `${SCRIPT_ID}-quota`;
    const QUOTA_WINDOW_MS = 60 * 60 * 1000;  // fenêtre glissante d'une heure
    const QUOTA_DISPLAY_MS = 30 * 1000;      // rafraîchissement de l'affichage (les éditions sortent de la fenêtre)
    // Plafond d'éditions scriptées par heure, par pays (clé : code pays WME, ou nom). Charte France §3.3 : 500/h.
    const HOURLY_LIMITS = { FR: 500, France: 500 };

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
    let quotaLabel;
    /** Pays courant : { key, label, name } (null si inconnu). */
    let currentCountry = null;
    /** Éditions scriptées non enregistrées : clé de pays -> Set de clés d'objets (un objet compte une fois). */
    const pendingEdits = new Map();
    /** Vrai quand le plafond a interrompu l'exécution en cours. */
    let quotaBlocked = false;
    /** Vrai pendant l'exécution de Clean : les éditions réservées ne sont pas encore toutes écrites. */
    let cleanRunning = false;

    /** Ids des segments touchés depuis le dernier enregistrement (le SDK n'expose pas d'état "modifié"). */
    const editedIds = new Set();
    /** Résultat courant : [{ id, length }] */
    let shortSegments = [];
    /** Nœuds non connectés des nouveaux segments */
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
            delete: `Supprimer les segments < ${MAX_LENGTH_M} m`,
            clean: 'Nettoyer les nouveaux segments et la sélection (sans nom, sans ville)',
            roadType: 'Type Street (segments non enregistrés et sélection)',
            unpaved: 'Retirer « non bitumé » (segments non enregistrés et sélection)',
            twoWay: 'Double sens (segments non enregistrés et sélection)',
            geometry: 'Simplifier la géométrie (points de forme, nœuds inutiles)',
            mergeFailed: (msg) => `Goldfish : fusion impossible (${msg})`,
            simplified: (s, m) => `Goldfish : ${s} segment(s) simplifié(s), ${m} nœud(s) inutile(s) supprimé(s)`,
            quotaTitle: (name, used, limit, pending) => `${name} : ${used}/${limit} éditions scriptées sur la dernière heure (dont ${pending} en attente d'enregistrement)`,
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
            delete: `Delete segments < ${MAX_LENGTH_M} m`,
            clean: 'Clean new segments and the selection (no name, no city)',
            roadType: 'Street type (unsaved segments and selection)',
            unpaved: 'Remove "unpaved" (unsaved segments and selection)',
            twoWay: 'Two-way (unsaved segments and selection)',
            geometry: 'Simplify geometry (shape points, useless nodes)',
            mergeFailed: (msg) => `Goldfish: merge failed (${msg})`,
            simplified: (s, m) => `Goldfish: ${s} segment(s) simplified, ${m} useless node(s) removed`,
            quotaTitle: (name, used, limit, pending) => `${name}: ${used}/${limit} scripted edits in the last hour (${pending} pending save)`,
            quotaCountry: (name) => `Country: ${name} (no scripted-edit limit)`,
            quotaReached: (name, limit) => `Goldfish: hourly limit of ${limit} scripted edits reached (${name}), actions stopped`,
        },
    };
    let lang = 'en';
    /** Texte traduit (langue de WME, anglais par défaut). */
    function t(key, ...args) {
        const v = MESSAGES[lang][key] ?? MESSAGES.en[key];
        return typeof v === 'function' ? v(...args) : v;
    }
    /** Choisit la langue selon la locale de WME (repli : langue du navigateur). */
    function detectLang() {
        let code = '';
        try { code = sdk.Settings.getLocale()?.localeCode ?? ''; } catch (e) { /* repli ci-dessous */ }
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
        await registerScriptTab();
        createToolbar();
        registerEvents();
        // Affichage seulement : les éditions anciennes sortent de la fenêtre d'une heure, ou un autre onglet les a enregistrées.
        setInterval(updateQuotaLabel, QUOTA_DISPLAY_MS);
        window.addEventListener('storage', (e) => e.key === QUOTA_KEY && updateQuotaLabel());
        await refresh();
        console.log(`[${SCRIPT_ID}] chargé`);
    }

    /** Onglet « Scripts » de WME : nom et version du script. */
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

    /** Vrai si un segment autre que `ownIds` passe à moins de NEAR_DISTANCE_M de `point` ([lon, lat]). */
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

    /** Nœuds des nouveaux segments (id négatif) non reliés à un autre segment, avec un segment à moins de 20 m. */
    async function findUnconnectedNodes() {
        const nodes = new Map();
        const allSegments = await sdk.DataModel.Segments.getAll();
        for (const segment of allSegments) {
            if (segment.id >= 0) continue;
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

    // ------------------------------------------------------------ quota

    /** Journal des éditions enregistrées : { [pays]: [[horodatage, nombre], ...] }, relu à chaque accès (partagé entre onglets). */
    function loadQuota() {
        let data = {};
        try {
            data = JSON.parse(localStorage.getItem(QUOTA_KEY)) ?? {};
        } catch (e) { /* journal illisible : on repart de zéro */ }
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
            // stockage indisponible : le compteur ne survivra pas au rechargement
        }
    }

    /** Éditions enregistrées sur la dernière heure pour ce pays. */
    function committedCount(key) {
        return (loadQuota()[key] ?? []).reduce((sum, [, n]) => sum + n, 0);
    }

    function pendingCount(key) {
        return pendingEdits.get(key)?.size ?? 0;
    }

    /** Plafond horaire du pays (null : pas de plafond). */
    function limitFor(country) {
        if (!country) return null;
        return HOURLY_LIMITS[country.key] ?? HOURLY_LIMITS[country.name] ?? null;
    }

    function toCountryInfo(country) {
        const name = country.name ?? String(country.id);
        const key = country.abbr ?? name;
        return { key, label: key, name };
    }

    async function refreshCountry() {
        try {
            const country = await sdk.DataModel.Countries.getTopCountry();
            currentCountry = country ? toCountryInfo(country) : null;
        } catch (e) {
            currentCountry = null;
        }
    }

    /**
     * Réserve des éditions (clés d'objets) avant d'écrire. Retourne false, sans rien réserver, si le plafond
     * horaire du pays serait dépassé. Un objet déjà modifié en attente d'enregistrement ne compte qu'une fois.
     */
    function reserveEdits(keys) {
        if (!currentCountry || quotaBlocked) return !quotaBlocked;
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

    /**
     * Les éditions en attente passent dans le journal à l'enregistrement (la charte les compte à ce moment-là).
     * Appelé aussi quand plus aucune modification n'est en attente : par prudence on les compte alors comme
     * enregistrées (un « tout annuler » les compte donc à tort, ce qui reste du côté sûr).
     */
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

    /** Pays courant et compteur de la dernière heure dans la toolbar (compteur seulement si le pays a un plafond). */
    function updateQuotaLabel() {
        if (!quotaLabel) return;
        if (!currentCountry) {
            quotaLabel.textContent = '';
            quotaLabel.title = '';
            return;
        }
        const limit = limitFor(currentCountry);
        if (limit == null) {
            quotaLabel.textContent = currentCountry.label;
            quotaLabel.style.color = '#888';
            quotaLabel.title = t('quotaCountry', currentCountry.name);
            return;
        }
        const pending = pendingCount(currentCountry.key);
        const used = committedCount(currentCountry.key) + pending;
        quotaLabel.textContent = `${currentCountry.label} ${used}/${limit}`;
        quotaLabel.style.color = used >= limit ? '#c62828' : used >= limit * 0.8 ? '#e65100' : '#555';
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

    /** Retour visuel sur un bouton : survol et enfoncement (le bouton « bouge » au clic). */
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

    /** Icône du poisson (SVG inline, servie en data URI pour éviter l'injection de HTML). */
    const FISH_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g fill="#F37934"><path d="M240.835,288.625c-19.528,25.107-64.51,122.453-145.4,116.873c-80.901-5.579-89.27-58.583-89.27-58.583c13.948,0,69.015,22.068,75.603-22.828c8.684-59.159,90.377-62.252,90.377-62.252c-71.131-2.79-59.039-53.905-84.949-72.347C58.974,169.408,0,199.074,0,199.074c61.503-209.497,234.181,16.781,234.181,16.781c-13.21,10.377-21.59,21.862-21.59,33.954C212.591,263.822,223.847,277.022,240.835,288.625z"/><path d="M428.437,179.378c-14.969-6.111-31.88-9.997-50.67-9.997c-23.305,0-66.008,9.52-102.632,24.89c-41.444-46.708,4.982-63.815,13.981-63.945c17.596-0.25,43.321,0,97.02-20.928C439.834,88.48,428.437,179.378,428.437,179.378z"/><path d="M429.368,367.453c-24.999,18.138-117.351,11.875-116.58-2.725c1.042-19.81,9.965-31.783,19.549-40.586c17.161,3.929,32.673,6.09,43.777,6.09c23.023,0,43.224-5.84,60.483-14.437C442.437,324.305,453.422,346.091,429.368,367.453z"/></g><path fill="#FBA026" d="M512,249.803c0,0-25.313,45.308-73.4,69.243c-17.27,8.608-37.471,14.448-60.494,14.448c-46.22,0-168.77-37.471-168.77-83.69c0-22.914,30.133-43.68,66.138-58.789c36.624-15.37,79.327-24.89,102.632-24.89c18.79,0,35.701,3.886,50.67,9.997C483.235,198.319,512,249.803,512,249.803z"/><g fill="#F37934"><path d="M512,249.803c0,0-25.313,45.308-73.4,69.243h-0.011c-12.841-7.077-36.602-28.515-36.602-69.243s16.89-63.023,26.79-73.682C483.235,198.319,512,249.803,512,249.803z"/><path d="M363.809,226.055c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V226.055z"/><path d="M363.809,269.113c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V269.113z"/><path d="M363.809,312.169c-11.89,0-21.528-9.639-21.528-21.528c0-11.89,9.639-21.528,21.528-21.528V312.169z"/><path d="M304.107,233.808c-7.608,0-13.777-6.168-13.777-13.777c0-7.609,6.168-13.777,13.777-13.777V233.808z"/><path d="M304.107,261.361c-7.608,0-13.777-6.168-13.777-13.777c0-7.608,6.168-13.777,13.777-13.777V261.361z"/><path d="M304.107,288.913c-7.608,0-13.777-6.168-13.777-13.777c0-7.608,6.168-13.777,13.777-13.777V288.913z"/></g><circle fill="#CA463D" cx="446.229" cy="238.903" r="8.684"/></svg>')}`;

    /** Bouton « split » dans la toolbar de WME : poisson (exécute Clean) + ▾ (ouvre les options). */
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

        // Poignée de déplacement (double-clic : remet la barre dans la toolbar de WME).
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
            label.append(box, document.createTextNode(t(key)));
            body.appendChild(label);
        }
        document.body.appendChild(body);

        // Clic ailleurs : on referme les options.
        document.addEventListener('click', () => setExpanded(false));
        window.addEventListener('resize', () => expanded && positionOptions());

        // Rend le focus à la carte après un clic : un bouton ou une case qui garde le focus bloque les raccourcis de WME.
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
        toggleButton.title = expanded ? t('optHide') : t('optShow');
        if (expanded) positionOptions();
    }

    function updateToolbar() {
        const n = shortSegments.length;
        countLabel.textContent = n === 0 ? '' : String(n);
        countLabel.style.color = '#c2185b';
        countLabel.style.fontWeight = 'bold';
        cleanButton.title = n === 0 ? t('cleanTitle') : t('cleanTitleCount', n);
        updateQuotaLabel();
    }

    // ------------------------------------------------------- suppression

    async function deleteShortSegments() {
        // Recalcul pour ne pas supprimer sur la base d'un état périmé.
        const targets = await findShortSegments();
        let deleted = 0;
        for (const { id } of targets) {
            // Un segment non enregistré (id négatif) n'existe pas côté serveur : sa suppression ne compte pas.
            if (id >= 0 && !reserveEdits([`s${id}`])) break;
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
        // Nouveaux segments + segments sélectionnés (jamais tous les segments visibles).
        const ids = new Set((await sdk.DataModel.Segments.getAll()).filter((s) => s.id < 0).map((s) => s.id));
        const selection = await sdk.Editing.getSelection();
        if (selection && String(selection.objectType).toLowerCase() === 'segment') {
            for (const id of selection.ids ?? []) ids.add(id);
        }
        const targets = [...ids].map((id) => ({ id }));
        if (targets.length === 0) {
            console.log(`[${SCRIPT_ID}] clean : aucun segment nouveau ou sélectionné`);
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
                }
                cleaned++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] nettoyage impossible du segment ${id}`, e);
            }
        }
        console.log(`[${SCRIPT_ID}] ${cleaned}/${targets.length} segment(s) nettoyé(s)`);
    }

    /** Segments non enregistrés (id négatif) + segments sélectionnés. */
    async function getNewOrSelectedIds() {
        const ids = new Set((await sdk.DataModel.Segments.getAll()).filter((s) => s.id < 0).map((s) => s.id));
        const selection = await sdk.Editing.getSelection();
        if (selection && String(selection.objectType).toLowerCase() === 'segment') {
            for (const id of selection.ids ?? []) ids.add(id);
        }
        return [...ids];
    }

    /** Applique `apply(segment, id)` à chaque segment ciblé ; `apply` retourne false si rien à faire. */
    async function updateNewOrSelected(label, apply) {
        const ids = await getNewOrSelectedIds();
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
        // updateSegment échoue (InvalidStateError) quand rien ne change : on l'évite.
        return updateNewOrSelected('type Street', async (segment, id) => {
            if (segment.roadType === STREET_ROAD_TYPE) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateSegment({ segmentId: id, roadType: STREET_ROAD_TYPE });
        });
    }

    function removeUnpaved() {
        return updateNewOrSelected('non bitumé', async (segment, id) => {
            if (!segment.flagAttributes?.unpaved) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateSegment({ segmentId: id, flagAttributes: { unpaved: false } });
        });
    }

    function setTwoWay() {
        return updateNewOrSelected('double sens', async (segment, id) => {
            if (segment.isTwoWay) return false;
            if (!reserveEdits([`s${id}`])) return false;
            await sdk.DataModel.Segments.updateDirection({ segmentId: id, direction: 'TWO_WAY' });
        });
    }

    /** Exécute les actions cochées, dans l'ordre. */
    async function runClean() {
        cleanButton.disabled = true;
        cleanButton.style.opacity = '0.5'; // exécution en cours
        cleanButton.style.transform = 'none';
        // Pays de l'action (plafond horaire) : relu au lancement, la carte a pu bouger.
        quotaBlocked = false;
        cleanRunning = true;
        await refreshCountry();
        updateQuotaLabel();
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
                if (quotaBlocked) break; // plafond atteint : on n'enchaîne pas les étapes suivantes
                try {
                    await fn();
                } catch (e) {
                    console.error(`[${SCRIPT_ID}] erreur (${key})`, e);
                }
            }
        } finally {
            cleanRunning = false;
            cleanButton.blur();
            cleanButton.disabled = false;
            cleanButton.style.opacity = '1';
            cleanButton.style.background = 'transparent';
            await refresh();
        }
    }

    // ------------------------------------------------------- cible

    /**
     * Segments ciblés : la sélection s'il y en a une, sinon tous les segments visibles
     * (chargés dans l'emprise courante de la carte). Retourne une Map id -> segment.
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

    /** Tous les segments chargés dont une partie est dans l'emprise de la carte (sans tenir compte de la sélection). */
    async function getVisibleSegments() {
        const targets = new Map();
        let extent = null;
        try {
            extent = await sdk.Map.getMapExtent(); // [minLon, minLat, maxLon, maxLat]
        } catch (e) { /* pas d'emprise : on prend tous les segments chargés */ }
        for (const segment of await sdk.DataModel.Segments.getAll()) {
            if (extent && !segment.geometry.coordinates.some(([lon, lat]) =>
                lon >= extent[0] && lon <= extent[2] && lat >= extent[1] && lat <= extent[3])) continue;
            targets.set(segment.id, segment);
        }
        return targets;
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
        // Une passe n'est pas idempotente (les cordes changent une fois des points retirés) :
        // on répète jusqu'au point fixe pour qu'une nouvelle application ne change plus rien.
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

    /** Affiche un message furtif en bas de l'écran, qui disparaît seul après `durationMs`. */
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
     * Fusionne les segments reliés par un nœud « inutile » : nœud à exactement 2 segments,
     * de même type de route, même rue et sens compatibles. Retourne le nombre de segments supprimés par fusion.
     */
    async function mergeUselessNodes(targets) {
        let total = 0;
        // Cible stable d'une passe à l'autre : la sélection peut être perdue après une fusion.
        // On suit donc les ids de départ, plus les ids créés par les fusions (absents de l'état initial).
        const initialVisible = new Set((await getVisibleSegments()).keys());
        const targetIds = new Set(targets.keys());
        // mergeSegments refuse les groupes de plus de 2 segments : on fusionne deux par deux,
        // puis on relit les données (les ids changent) jusqu'à ce qu'il n'y ait plus rien à fusionner.
        for (let pass = 0; pass < 20; pass++) {
            const visible = await getVisibleSegments();
            const current = new Map();
            for (const [id, seg] of visible) {
                if (targetIds.has(id) || !initialVisible.has(id)) current.set(id, seg);
            }
            const n = await mergePass(current);
            if (n === 0 || quotaBlocked) break;
            total += n;
        }
        return total;
    }

    /** Une passe : fusionne des paires de segments disjointes. Retourne le nombre de fusions réussies. */
    async function mergePass(segments) {
        const known = new Map(segments);
        const getSeg = async (id) => {
            if (!known.has(id)) known.set(id, await sdk.DataModel.Segments.getById({ segmentId: id }));
            return known.get(id);
        };

        // Sens du segment vu depuis un nœud : 'both', 'in' (arrive au nœud) ou 'out' (part du nœud).
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
                if (!ids.every((id) => segments.has(id))) continue; // les deux segments doivent être dans la cible
                if (ids.some((id) => used.has(id))) continue;
                const [a, b] = await Promise.all(ids.map(getSeg));
                if (!a || !b || a.id === b.id) continue;
                if (a.roadType !== b.roadType || a.primaryStreetId !== b.primaryStreetId) continue;
                if (Boolean(a.isTwoWay) !== Boolean(b.isTwoWay)) continue;
                if (!a.isTwoWay && dirAt(a, nodeId) === dirAt(b, nodeId)) continue; // sens uniques incompatibles
                if (a.fromNodeId === b.fromNodeId && a.toNodeId === b.toNodeId) continue; // boucle
                used.add(a.id);
                used.add(b.id);
                pairs.push([a.id, b.id]);
            }
        }

        let merged = 0;
        for (const ids of pairs) {
            // Une fusion touche les deux segments d'origine et en crée un nouveau (clé fictive : son id est inconnu).
            if (!reserveEdits([...ids.map((id) => `s${id}`), `merge-${Date.now()}-${merged}`])) break;
            try {
                await sdk.DataModel.Segments.mergeSegments({ segmentIds: ids });
                merged++;
            } catch (e) {
                console.warn(`[${SCRIPT_ID}] fusion impossible des segments ${ids.join(', ')}`, e);
                showToast(t('mergeFailed', e?.message ?? e), 6000);
            }
        }
        return merged;
    }

    /** Réduit les points de forme des segments ciblés (sélection, sinon visibles) sans déplacer leurs extrémités. */
    async function simplifyGeometry() {
        try {
            let segments = await getTargetSegments();
            const merged = await mergeUselessNodes(segments);
            if (merged > 0) segments = await getTargetSegments(); // les ids ont changé après fusion
            let removed = 0;
            let simplifiedCount = 0;
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
                    simplifiedCount++;
                } catch (e) {
                    console.warn(`[${SCRIPT_ID}] simplification impossible du segment ${id}`, e);
                }
            }
            console.log(`[${SCRIPT_ID}] simplify geometry : ${removed} point(s) de forme supprimé(s), ${merged} nœud(s) inutile(s) fusionné(s)`);
            showToast(t('simplified', simplifiedCount, merged));
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
                await refreshCountry();
                // Plus aucune modification en attente : les éditions scriptées sont enregistrées (ou annulées).
                if (!cleanRunning && await sdk.Editing.getUnsavedChangesCount() === 0) commitPendingEdits();
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
                commitPendingEdits();
                scheduleRefresh();
            },
        });

        for (const eventName of ['wme-after-edit', 'wme-after-undo', 'wme-after-redo-clear', 'wme-map-data-loaded']) {
            sdk.Events.on({ eventName, eventHandler: scheduleRefresh });
        }
    }
})();
