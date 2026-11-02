import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import './scene.css';
import './delivery-route.css';

const PALETTE = { ground: 0xc4cdd1, edge: 0x909fa8, grass: 0x9bab9f, grassAlt: 0xa5b5a5, road: 0x84929e, path: 0xd3d8dc, ivory: 0xe1e5e8, white: 0xf2f3f0, glass: 0x829cab, line: 0xf5f7fa, mint: 0x4b88c8, aqua: 0x6099ba, amber: 0xe7a340 };
const MOBILE_TYPES = ['robot', 'drone', 'delivery_robot'];
const FILTERS = { energy: ['light', 'hvac', 'window'], security: ['robot', 'sensor'], fire: ['sensor'], delivery: ['drone', 'delivery_robot'], devices: ['light', 'hvac', 'window', 'sensor', 'robot', 'drone', 'delivery_robot'], equipment: ['light', 'hvac', 'window', 'sensor', 'robot', 'drone', 'delivery_robot'] };
const SYMBOLS = { light: '☀', hvac: '❄', window: '▥', sensor: '◉', robot: 'R', drone: '✧', delivery_robot: 'D' };
const normBuilding = (b, i) => ({ ...b, id: b.id || `B0${i + 1}`, x: Number(b.x) || 0, z: Number(b.z) || 0, width: Number(b.width) || 12, depth: Number(b.depth) || 10, height: Number(b.height) || 18, floors: Number(b.floors) || 6 });

function seeded(seed) { let n = seed; return () => { n = (n * 16807) % 2147483647; return (n - 1) / 2147483646; }; }

function material(color, options = {}) { return new THREE.MeshStandardMaterial({ color, roughness: .83, metalness: .05, ...options }); }
function box(w, h, d, mat, x = 0, y = 0, z = 0, parent) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); mesh.position.set(x, y, z); mesh.castShadow = h > .4; mesh.receiveShadow = true; parent?.add(mesh); return mesh;
}
function horizontalShape(shape, mat, height, parent) { const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 64), mat); mesh.rotation.x = -Math.PI / 2; mesh.position.y = height; mesh.receiveShadow = true; parent.add(mesh); return mesh; }
function makeRoundRect(w, h, r) {
  const x = -w / 2, y = -h / 2, s = new THREE.Shape();
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
}
function markerTexture(symbol, color) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const ctx = c.getContext('2d');
  ctx.shadowBlur = 18; ctx.shadowColor = color; ctx.beginPath(); ctx.arc(64, 64, 39, 0, Math.PI * 2); ctx.fillStyle = '#133936'; ctx.fill(); ctx.shadowBlur = 0; ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke(); ctx.fillStyle = color; ctx.font = 'bold 43px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(symbol, 64, 66); const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function softShadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const ctx = c.getContext('2d'); const g = ctx.createRadialGradient(64, 64, 5, 64, 64, 64); g.addColorStop(0, '#071f23aa'); g.addColorStop(.45, '#071f2366'); g.addColorStop(1, '#071f2300'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}

const ROUTE_COLORS = { pickup: 0xb86a1e, delivery: 0x2867c4, patrol: 0x397f6c };
const ACTIVE_ROUTES = ['running', 'paused', 'queued', 'returning'];

function routeVectors(points) {
  if (!Array.isArray(points) || !points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.z))) return [];
  return points.map(p => new THREE.Vector3(p.x, (Number.isFinite(p.y) ? p.y : .5) + .06, p.z));
}

function drawRoute(layer, points, color, dashed, paused) {
  if (points.length < 2) return;
  const options = { color, transparent: true, opacity: paused ? .45 : .95 };
  const lineMaterial = dashed
    ? new THREE.LineDashedMaterial({ ...options, dashSize: 1.4, gapSize: .65 })
    : new THREE.LineBasicMaterial(options);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial);
  if (dashed) line.computeLineDistances();
  layer.add(line);
}

function markRouteStop(layer, point, color) {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: .9 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(.8, 1.1, 24), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(point);
  layer.add(ring);
}

function drawPlannedRoute(layer, plan, paused) {
  if (!plan) return false;
  const pickup = routeVectors(plan.pickup?.points), transport = routeVectors(plan.delivery?.points);
  if (pickup.length && transport.length >= 2) {
    drawRoute(layer, pickup, ROUTE_COLORS.pickup, true, paused);
    drawRoute(layer, transport, ROUTE_COLORS.delivery, false, paused);
    markRouteStop(layer, transport[0], ROUTE_COLORS.pickup);
    markRouteStop(layer, transport[transport.length - 1], ROUTE_COLORS.delivery);
    return true;
  }
  const whole = routeVectors(plan.points);
  if (whole.length < 2) return false;
  drawRoute(layer, whole, ROUTE_COLORS.delivery, false, paused);
  markRouteStop(layer, whole[whole.length - 1], ROUTE_COLORS.delivery);
  return true;
}

export default function ParkScene({ buildings = [], devices = [], alerts = [], patrols = [], deliveries = [], layer = 'overview', selectedId, onSelect, onReady, focusTarget, resetKey = 0, view = 'perspective', floor = 0, showLabels = true, framing = 'detail' }) {
  const host = useRef(null), engine = useRef(null), props = useRef({}), [webglError, setWebglError] = useState(false), [ready, setReady] = useState(false);
  props.current = { buildings, devices, alerts, layer, selectedId, onSelect, onReady, focusTarget, view, floor, showLabels, framing };
  const signature = JSON.stringify(buildings.map(b => [b.id, b.x, b.z, b.width, b.depth, b.height, b.floors, b.name]));
  const campus = useMemo(() => buildings.map(normBuilding), [signature]);

  useEffect(() => {
    if (!host.current || !campus.length) return;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); } catch { setWebglError(true); onReady?.(); return; }
    setWebglError(false);
    const container = host.current, scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xdce5ed, .0014);
    const camera = new THREE.PerspectiveCamera(36, 1, .5, 600); camera.position.set(100, 105, 119);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7)); renderer.setClearColor(0x000000, 0); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35; container.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', '白鹭湾三维园区，可拖动旋转、滚轮缩放、右键平移，并点击建筑和设备'); renderer.domElement.setAttribute('role', 'img');
    const labelRenderer = new CSS2DRenderer(); labelRenderer.domElement.className = 'scene-label-layer'; container.appendChild(labelRenderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 2, 0); controls.enableDamping = true; controls.dampingFactor = .065; controls.maxPolarAngle = Math.PI / 2.25; controls.minPolarAngle = .07; controls.minDistance = 35; controls.maxDistance = 240; controls.maxTargetRadius = 45; controls.enablePan = true; controls.rotateSpeed = .55; controls.zoomSpeed = .7;
    scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x8c969f, 2.1));
    const sun = new THREE.DirectionalLight(0xf2f3d7, 3.0); sun.position.set(-55, 100, 35); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -95, right: 95, top: 85, bottom: -85, near: 1, far: 240 }); sun.shadow.bias = -.0003; sun.shadow.normalBias = .04; sun.shadow.radius = 3; scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb6cce5, 1.0); fill.position.set(70, 25, -50); scene.add(fill);
    const root = new THREE.Group(); scene.add(root);
    const materials = { ground: material(PALETTE.ground), road: material(PALETTE.road), path: material(PALETTE.path), grass: material(PALETTE.grass), grassAlt: material(PALETTE.grassAlt), facade: material(PALETTE.ivory), facadeLight: material(PALETTE.white), glass: material(PALETTE.glass, { metalness: .35, roughness: .26 }), floor: material(0xaab5b8), roof: material(0x909f9c), mint: material(PALETTE.mint, { emissive: 0x5b8eaf, emissiveIntensity: .25 }), steel: material(0x566876), water: material(0x778e98, { roughness: .3, metalness: .35 }), amber: material(PALETTE.amber, { emissive: 0xbf7131, emissiveIntensity: .4 }), bark: material(0x5c665f) };
    const baseShape = makeRoundRect(156, 113, 7);
    // Extrusion plus bevel reaches depth + bevelThickness along world Y after rotation.
    // Keep that cap below the separately rendered terrain, roads and wetland surfaces.
    const base = new THREE.Mesh(new THREE.ExtrudeGeometry(baseShape, { depth: 2.4, bevelEnabled: true, bevelSize: .8, bevelThickness: .8, bevelSegments: 3, steps: 1 }), material(PALETTE.edge)); base.rotation.x = -Math.PI / 2; base.position.y = -3.3; base.receiveShadow = true; root.add(base);
    horizontalShape(baseShape, materials.ground, .04, root);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(base.geometry, 25), new THREE.LineBasicMaterial({ color: 0x517b7c, transparent: true, opacity: .22 })); base.add(edge);
    // East wetland: curved shoreline and reflecting water are native scene geometry.
    const wetland = new THREE.Shape(); wetland.moveTo(54, -54); wetland.bezierCurveTo(39, -45, 53, -29, 45, -12); wetland.bezierCurveTo(37, 4, 56, 16, 45, 37); wetland.quadraticCurveTo(42, 48, 54, 54); wetland.lineTo(72, 54); wetland.quadraticCurveTo(77, 53, 77, 47); wetland.lineTo(77, -47); wetland.quadraticCurveTo(76, -54, 70, -54); wetland.closePath(); horizontalShape(wetland, materials.water, .10, root);
    const shorelinePoints = []; for (let i = 0; i <= 64; i++) { const t = i / 64, z = -53 + t * 106; shorelinePoints.push(new THREE.Vector3(48 + Math.sin(t * Math.PI * 3.2) * 4.5, .14, z)); }
    const shore = new THREE.Line(new THREE.BufferGeometry().setFromPoints(shorelinePoints), new THREE.LineBasicMaterial({ color: 0x7bbab0, transparent: true, opacity: .6 })); root.add(shore);
    for (let i = 0; i < 18; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(5 + i % 4, .035), new THREE.MeshBasicMaterial({ color: 0x8ccfc2, transparent: true, opacity: .15 })); p.rotation.x = -Math.PI / 2; p.position.set(55 + (i * 7 % 16), .13, -46 + i * 5.4); root.add(p); }
    // Street grid, inset sidewalks and fine road markings.
    const roads = new THREE.Group(); root.add(roads);
    box(135, .12, 8.5, materials.path, -6, .12, 0, roads); box(135, .14, 6.5, materials.road, -6, .2, 0, roads);
    box(8.5, .12, 100, materials.path, 4, .12, 0, roads); box(6.5, .14, 100, materials.road, 4, .2, 0, roads);
    box(127, .12, 6, materials.path, -7, .12, 43, roads); box(127, .14, 4.5, materials.road, -7, .2, 43, roads);
    box(127, .12, 6, materials.path, -7, .12, -43, roads); box(127, .14, 4.5, materials.road, -7, .2, -43, roads);
    box(6, .12, 91, materials.path, -66, .12, 0, roads); box(4.5, .14, 91, materials.road, -66, .2, 0, roads);
    const dashMaterial = new THREE.MeshBasicMaterial({ color: 0x9cbcb0, transparent: true, opacity: .48 });
    for (let x = -68; x < 57; x += 5) { if (Math.abs(x - 4) > 6) box(2.5, .015, .11, dashMaterial, x, .29, 0, roads); }
    for (let z = -46; z <= 46; z += 5) { if (Math.abs(z) > 6 && Math.abs(z) < 40) box(.11, .015, 2.4, dashMaterial, 4, .29, z, roads); }
    for (const cross of [{ x: -3, z: 0, rotate: false }, { x: 11, z: 0, rotate: false }, { x: 4, z: -8, rotate: true }, { x: 4, z: 8, rotate: true }]) for (let i = 0; i < 7; i++) box(cross.rotate ? .38 : 2.0, .018, cross.rotate ? 2.0 : .38, dashMaterial, cross.x + (cross.rotate ? (i - 3) * .7 : 0), .3, cross.z + (cross.rotate ? 0 : (i - 3) * .7), roads);
    // Soft garden squares with path borders and planted beds.
    const greenZones = [{ x: -30, z: 22, w: 60, d: 33 }, { x: -30, z: -23, w: 60, d: 33 }, { x: 26, z: 23, w: 34, d: 33 }, { x: 26, z: -23, w: 34, d: 33 }];
    greenZones.forEach((g, i) => { box(g.w, .15, g.d, materials.path, g.x, .15, g.z, root); box(g.w - .6, .16, g.d - .6, i % 2 ? materials.grassAlt : materials.grass, g.x, .2, g.z, root); });
    // Data-driven architecture. Floor meshes remain individually selectable for cutaway.
    const buildingGroups = new Map(), pickables = [], labels = [], shadowTex = softShadowTexture();
    campus.forEach((b, index) => {
      const g = new THREE.Group(); g.position.set(b.x, .35, b.z); g.userData = { kind: 'building', id: b.id }; root.add(g);
      const floorHeight = b.height / b.floors, floors = [];
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(b.width * 2.25, b.depth * 2.25), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: .7 })); shadow.rotation.x = -Math.PI / 2; shadow.position.set(.9, .02, .9); g.add(shadow);
      box(b.width + 3.2, .22, b.depth + 3.2, materials.path, 0, .1, 0, g);
      const podium = box(b.width + 1.2, .55, b.depth + 1.2, materials.floor, 0, .45, 0, g); podium.userData = g.userData; pickables.push(podium);
      const windowItems = []; const windowGeo = new THREE.BoxGeometry(.65, .95, .045);
      for (let f = 0; f < b.floors; f++) {
        const fg = new THREE.Group(); fg.position.y = .8 + f * floorHeight; g.add(fg); floors.push(fg);
        const slab = box(b.width + .16, .14, b.depth + .16, materials.facadeLight, 0, .1, 0, fg); slab.userData = { ...g.userData, floor: f + 1 }; pickables.push(slab);
        const core = box(b.width, floorHeight - .13, b.depth, index % 3 === 0 ? materials.facadeLight : materials.facade, 0, floorHeight / 2 + .12, 0, fg); core.userData = slab.userData; pickables.push(core);
        const band = box(b.width + .025, floorHeight * .49, b.depth + .025, materials.glass, 0, floorHeight * .57, 0, fg); band.castShadow = false; band.userData = slab.userData; pickables.push(band);
        const mullionMaterial = index % 3 === 0 ? materials.facadeLight : materials.facade;
        const mullions = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mullionMaterial, Math.ceil(b.width / 2.3) + Math.ceil(b.depth / 2.3)); const mullionDummy = new THREE.Object3D(); let mullionCount = 0;
        for (let x = -b.width / 2 + 1.2; x < b.width / 2; x += 2.3) { mullionDummy.position.set(x, floorHeight * .57, 0); mullionDummy.scale.set(.12, floorHeight * .54, b.depth + .07); mullionDummy.updateMatrix(); mullions.setMatrixAt(mullionCount++, mullionDummy.matrix); }
        for (let z = -b.depth / 2 + 1.2; z < b.depth / 2; z += 2.3) { mullionDummy.position.set(0, floorHeight * .57, z); mullionDummy.scale.set(b.width + .07, floorHeight * .54, .12); mullionDummy.updateMatrix(); mullions.setMatrixAt(mullionCount++, mullionDummy.matrix); }
        mullions.count = mullionCount; fg.add(mullions);
        const lit = new THREE.InstancedMesh(windowGeo, new THREE.MeshBasicMaterial({ color: index % 2 ? 0xdbe7b8 : 0xc4f1d8, transparent: true, opacity: .63 }), Math.ceil(b.width / 2.3) * 2 + Math.ceil(b.depth / 2.3) * 2); const dummy = new THREE.Object3D(); let count = 0;
        for (let x = -b.width / 2 + 1.2; x < b.width / 2; x += 2.3) for (const side of [-1, 1]) { dummy.position.set(x + .35, floorHeight * .57, side * (b.depth / 2 + .05)); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, Math.min(1, floorHeight * .28), 1); dummy.updateMatrix(); lit.setMatrixAt(count++, dummy.matrix); }
        for (let z = -b.depth / 2 + 1.2; z < b.depth / 2; z += 2.3) for (const side of [-1, 1]) { dummy.position.set(side * (b.width / 2 + .05), floorHeight * .57, z + .35); dummy.rotation.set(0, Math.PI / 2, 0); dummy.updateMatrix(); lit.setMatrixAt(count++, dummy.matrix); }
        lit.count = count; fg.add(lit); windowItems.push(lit);
      }
      const roof = new THREE.Group(); roof.position.y = b.height + .9; g.add(roof);
      box(b.width + .55, .32, b.depth + .55, materials.facadeLight, 0, 0, 0, roof);
      box(b.width - .8, .13, b.depth - .8, materials.roof, 0, .23, 0, roof);
      box(b.width * .37, .9, b.depth * .4, materials.facade, -b.width * .13, .7, -b.depth * .1, roof);
      for (let k = 0; k < 3; k++) { box(1.4, .38, 1.5, materials.steel, b.width * .27, .5, -b.depth * .23 + k * 1.9, roof); box(1.2, .05, 1.3, materials.glass, b.width * .27, .71, -b.depth * .23 + k * 1.9, roof); }
      // Solar panels and rooftop garden, inset to avoid overdraw.
      if (index % 2 === 0) for (let j = 0; j < 4; j++) { const panel = box(1.5, .08, 2.2, materials.glass, -b.width * .25 + j * 1.8, .4, b.depth * .27, roof); panel.rotation.x = -.18; }
      const led = box(b.width + .6, .06, .07, materials.mint, 0, b.height + .83, b.depth / 2 + .3, g);
      const entry = box(b.width * .36, 1.3, 2.3, materials.glass, 0, .7, b.depth / 2 + .65, g); entry.userData = g.userData; pickables.push(entry);
      box(b.width * .43, .16, 3.2, materials.facadeLight, 0, 1.42, b.depth / 2 + .9, g);
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.width + .9, b.height + 1.2, b.depth + .9)), new THREE.LineBasicMaterial({ color: 0x9ff7c9, transparent: true, opacity: .9 })); outline.position.y = b.height / 2 + .6; outline.visible = false; g.add(outline);
      const labelEl = document.createElement('button'); labelEl.className = 'scene-building-label'; const labelCode = document.createElement('span'); labelCode.textContent = b.code || b.id; labelEl.append(labelCode, document.createTextNode(b.name)); labelEl.setAttribute('aria-label', `查看 ${b.name}`); labelEl.addEventListener('click', e => { e.stopPropagation(); props.current.onSelect?.({ kind: 'building', id: b.id }); });
      const label = new CSS2DObject(labelEl); label.position.set(0, b.height + 2.9, 0); g.add(label); labels.push({ label, element: labelEl, id: b.id }); buildingGroups.set(b.id, { group: g, floors, roof, outline, label, data: b, led });
    });
    // Landscape instancing keeps the campus cheap to render even with hundreds of trees.
    const rnd = seeded(407), treePositions = [];
    const collides = (x, z) => campus.some(b => Math.abs(x - b.x) < b.width / 2 + 2.2 && Math.abs(z - b.z) < b.depth / 2 + 2.2);
    for (let i = 0; i < 800 && treePositions.length < 240; i++) { const x = rnd() * 116 - 63, z = rnd() * 91 - 45; if (Math.abs(x - 4) < 6 || Math.abs(z) < 6 || Math.abs(z) > 39 || collides(x, z)) continue; treePositions.push([x, z, .65 + rnd() * .55]); }
    for (let z = -45; z <= 48; z += 4.3) { const x = 48 + Math.sin((z + 53) / 106 * Math.PI * 3.2) * 4.5 - 2.5; if (!collides(x, z)) treePositions.push([x, z, .8]); }
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.15, .21, 1.8, 5), materials.bark, treePositions.length);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.35, 1), material(0xffffff), treePositions.length); const treeDummy = new THREE.Object3D();
    treePositions.forEach(([x, z, size], i) => { treeDummy.position.set(x, size, z); treeDummy.scale.set(size, size, size); treeDummy.rotation.set(0, rnd() * Math.PI, 0); treeDummy.updateMatrix(); trunks.setMatrixAt(i, treeDummy.matrix); treeDummy.position.y = 2.1 * size; treeDummy.scale.set(size, size * 1.2, size); treeDummy.updateMatrix(); crowns.setMatrixAt(i, treeDummy.matrix); crowns.setColorAt(i, new THREE.Color().setHSL(.33 + rnd() * .04, .08 + rnd() * .06, .22 + rnd() * .08)); }); trunks.castShadow = true; crowns.castShadow = true; crowns.receiveShadow = true; root.add(trunks, crowns);
    // Forecourt paving, fixtures and park signage.
    for (let x = -59; x < 41; x += 7.5) for (const z of [-4.8, 4.8]) if (!collides(x, z)) { box(.15, 2.7, .15, materials.steel, x, 1.4, z, root); box(.6, .14, .45, materials.mint, x, 2.8, z, root); }
    const parking = new THREE.Group(); root.add(parking);
    const carMats = [material(0xa5c5bb), material(0x638b8a), material(0xb9b7a1), material(0x365758)];
    for (let i = 0; i < 14; i++) { const x = -56 + i * 5.8, z = 47; box(4.1, .02, 2.8, materials.road, x, .25, z, parking); box(.06, .02, 3, dashMaterial, x - 2.2, .28, z, parking); const car = new THREE.Group(); car.position.set(x, .38, z); car.rotation.y = .1; box(1.6, .5, 2.8, carMats[i % 4], 0, .45, 0, car); box(1.4, .45, 1.5, materials.glass, 0, .89, -.15, car); parking.add(car); }
    // Dock platform and drone landing pad by the wetland.
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, .25, 48), materials.path); pad.position.set(39, .33, 33); root.add(pad);
    const padRing = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.2, 48), new THREE.MeshBasicMaterial({ color: 0xa2d3bd, side: THREE.DoubleSide })); padRing.rotation.x = -Math.PI / 2; padRing.position.set(39, .49, 33); root.add(padRing); box(.2, .03, 2, materials.mint, 38.4, .5, 33, root); box(.2, .03, 2, materials.mint, 39.6, .5, 33, root); box(1.2, .03, .2, materials.mint, 39, .5, 33, root);
    const deviceLayer = new THREE.Group(), alertLayer = new THREE.Group(), routeLayer = new THREE.Group(); root.add(deviceLayer, alertLayer, routeLayer);
    const deviceObjects = new Map(), alertObjects = new Map(), textureCache = new Map();
    const getTex = (symbol, color) => { const key = symbol + color; if (!textureCache.has(key)) textureCache.set(key, markerTexture(symbol, color)); return textureCache.get(key); };
    const animateItems = [];
    const api = { scene, camera, controls, renderer, buildingGroups, pickables, deviceLayer, alertLayer, routeLayer, deviceObjects, alertObjects, labels, getTex, animateItems, targetCamera: null, targetLook: null, view: 'perspective', ready: true, focus(id, kind, top = false) {
      let position, radius = 42;
      if (kind === 'device' && deviceObjects.has(id)) { position = deviceObjects.get(id).group.position.clone(); radius = 34; }
      else if (kind === 'alert' && alertObjects.has(id)) { position = alertObjects.get(id).group.position.clone(); radius = 45; }
      else if (buildingGroups.has(id)) { const b = buildingGroups.get(id).data; position = new THREE.Vector3(b.x, Math.min(b.height / 3, 7), b.z); radius = Math.max(b.width, b.depth, b.height) * 2.1; }
      if (position) { this.targetLook = position; this.targetCamera = position.clone().add(top ? new THREE.Vector3(.01, radius * 1.6, 0) : new THREE.Vector3(radius * .85, radius, radius * 1.15)); }
    }, reset(top = false) { const home=props.current.framing==='home'; const fit=Math.min(2.1,Math.max(1,1.2/this.camera.aspect))*(home?1.18:1); this.controls.maxDistance=home?500:240; this.targetLook = new THREE.Vector3(-4, 2, 0); this.targetCamera = top ? new THREE.Vector3(-4, 163*fit, .01) : new THREE.Vector3(103, 104, 121).multiplyScalar(fit); } };
    engine.current = api;
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let pointerStart = null, frame = 0, lastTime = 0, disposed = false;
    const pointerDown = e => { pointerStart = { x: e.clientX, y: e.clientY }; };
    const isVisible = object => { for (let node = object; node; node = node.parent) if (!node.visible) return false; return true; };
    const pickTargets = () => [...api.pickables.filter(isVisible), ...[...deviceObjects.values()].filter(o => isVisible(o.marker)).map(o => o.marker), ...[...alertObjects.values()].filter(o => isVisible(o.marker)).map(o => o.marker)];
    const pointerUp = e => { if (!pointerStart || Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 6) return; const bounds = renderer.domElement.getBoundingClientRect(); pointer.set(((e.clientX - bounds.left) / bounds.width) * 2 - 1, -((e.clientY - bounds.top) / bounds.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(pickTargets(), false)[0]; if (hit?.object?.userData?.kind) props.current.onSelect?.({ ...hit.object.userData }); };
    let lastPointerCheck = 0;
    const pointerMove = e => { if (e.buttons || performance.now() - lastPointerCheck < 75) return; lastPointerCheck = performance.now(); const bounds = renderer.domElement.getBoundingClientRect(); pointer.set(((e.clientX - bounds.left) / bounds.width) * 2 - 1, -((e.clientY - bounds.top) / bounds.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(pickTargets(), false)[0]; api.hoveredDevice = hit?.object?.userData?.kind === 'device' ? hit.object.userData.id : null; renderer.domElement.style.cursor = hit ? 'pointer' : 'grab'; };
    const pointerLeave = () => { api.hoveredDevice = null; };
    const stopFocus = () => { api.targetCamera = null; api.targetLook = null; };
    renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', pointerUp); renderer.domElement.addEventListener('pointermove', pointerMove); renderer.domElement.addEventListener('pointerleave', pointerLeave); controls.addEventListener('start', stopFocus);
    const resize = new ResizeObserver(() => { const w = Math.max(container.clientWidth, 1), h = Math.max(container.clientHeight, 1); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); labelRenderer.setSize(w, h); if(!props.current.focusTarget)api.reset(props.current.view==='top'); }); resize.observe(container);
    const tick = time => { if (disposed) return; frame = requestAnimationFrame(tick); if (document.hidden || time - lastTime < 1000 / 40) return; lastTime = time; const t = time * .001;
      if (api.targetCamera && api.targetLook) { camera.position.lerp(api.targetCamera, .075); controls.target.lerp(api.targetLook, .075); if (camera.position.distanceTo(api.targetCamera) < .08) { api.targetCamera = null; api.targetLook = null; } }
      controls.update();
      for (const item of deviceObjects.values()) { if (item.target) item.group.position.lerp(item.target, .05); if (item.mobile && item.group.visible) { item.marker.position.y = item.markerBase + Math.sin(t * 1.5 + item.phase) * .14; item.rotors?.forEach(r => { r.rotation.y = t * 16; }); } if (item.label) { const current = props.current; const relevantTheme = current.layer === 'security' && item.data.type === 'robot' || current.layer === 'delivery' && ['drone', 'delivery_robot'].includes(item.data.type); item.label.visible = current.showLabels && (relevantTheme || item.data.id === current.selectedId || item.data.id === api.hoveredDevice); } }
      for (const item of alertObjects.values()) { const pulse = (t * .45 + item.phase) % 1; item.ring.scale.setScalar(1 + pulse * .65); item.ring.material.opacity = (1 - pulse) * .55; }
      renderer.render(scene, camera); labelRenderer.render(scene, camera);
    }; frame = requestAnimationFrame(tick); setReady(true); props.current.onReady?.();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose(); renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp); renderer.domElement.removeEventListener('pointermove', pointerMove); renderer.domElement.removeEventListener('pointerleave', pointerLeave); const geometries = new Set(), mats = new Set(), textures = new Set(); scene.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { mats.add(m); if (m.map) textures.add(m.map); }); if (o.isCSS2DObject) o.element.remove(); }); geometries.forEach(g => g.dispose()); mats.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); textureCache.forEach(t => t.dispose()); renderer.dispose(); renderer.domElement.remove(); labelRenderer.domElement.remove(); engine.current = null; };
  }, [signature]);

  useEffect(() => {
    const api = engine.current; if (!api) return;
    const validIds = new Set(devices.map(d => d.id));
    for (const [id, item] of api.deviceObjects) if (!validIds.has(id)) { api.deviceLayer.remove(item.group); item.group.traverse(o => { o.geometry?.dispose(); if (o.material) o.material.dispose(); if (o.isCSS2DObject) o.element.remove(); }); api.deviceObjects.delete(id); }
    devices.forEach((d, i) => {
      const b = api.buildingGroups.get(d.buildingId)?.data, mobile = MOBILE_TYPES.includes(d.type);
      // Floor devices use four facade slots; identical sensor coordinates otherwise make them impossible to pick.
      const slot = ['light', 'hvac', 'window', 'sensor'].indexOf(d.type);
      const position = new THREE.Vector3(
        !mobile && b ? b.x + (slot - 1.5) * Math.min(2.6, b.width / 4.6) : Number(d.position?.x ?? b?.x ?? 0),
        mobile ? (d.type === 'drone' ? Number(d.position?.y || 8) : .5) : (Number(d.position?.y) || (b?.height || 5) + 1.2),
        !mobile && b ? b.z + b.depth / 2 + .75 : Number(d.position?.z ?? b?.z ?? 0));
      let item = api.deviceObjects.get(d.id);
      if (!item) {
        const group = new THREE.Group(); group.position.copy(position); api.deviceLayer.add(group); const color = d.status === 'offline' ? '#91a1aa' : d.status === 'alert' ? '#ffc07f' : '#99e3bd';
        const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: api.getTex(SYMBOLS[d.type] || '•', color), depthTest: false, transparent: true })); marker.scale.setScalar(mobile ? 3.1 : 2.6); marker.position.y = mobile ? 3.4 : 1.2; marker.userData = { kind: 'device', id: d.id }; marker.renderOrder = 10; group.add(marker);
        const ring = new THREE.Mesh(new THREE.RingGeometry(.65, .78, 28), new THREE.MeshBasicMaterial({ color: mobile ? 0x8ae4c2 : 0x92bfb7, side: THREE.DoubleSide, transparent: true, opacity: .7 })); ring.rotation.x = -Math.PI / 2; ring.position.y = .07; group.add(ring);
        const rotors = [];
        if (d.type === 'drone') { box(.8, .3, 1.1, material(0xc4ded4), 0, .35, 0, group); for (const x of [-.65, .65]) for (const z of [-.65, .65]) { const arm = box(1.9, .09, .12, material(0x769e99), 0, .45, 0, group); arm.rotation.y = x * z > 0 ? Math.PI / 4 : -Math.PI / 4; const rotor = box(1.05, .025, .12, material(0xa5d8cd), x, .65, z, group); rotors.push(rotor); } }
        else if (mobile) { box(1.0, .8, 1.6, material(0xbdd4c7), 0, .6, 0, group); box(.86, .25, .7, material(0x2e6768), 0, 1.1, -.2, group); for (const x of [-.54, .54]) for (const z of [-.5, .5]) { const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.24, .24, .14, 12), material(0x1a393b)); wheel.rotation.z = Math.PI / 2; wheel.position.set(x, .35, z); group.add(wheel); } }
        let label;
        if (mobile) { const el = document.createElement('button'); el.className = 'scene-mobile-label'; el.textContent = `${d.name} · ${d.state?.battery ?? '—'}%`; el.onclick = () => props.current.onSelect?.({ kind: 'device', id: d.id }); label = new CSS2DObject(el); label.position.set(0, 5.6, 0); label.visible = false; group.add(label); }
        item = { group, marker, mobile, ring, rotors, label, markerBase: marker.position.y, phase: i * .57, data: d }; api.deviceObjects.set(d.id, item);
      }
      item.target = position; item.data = d;
      if (item.label) { item.label.element.textContent = `${d.name} · ${d.state?.battery ?? '—'}%`; item.label.element.classList.toggle('is-alert', d.status === 'alert' || d.status === 'offline'); }
      const match = FILTERS[layer]; item.group.visible = d.id === selectedId || (match ? match.includes(d.type) : mobile);
      item.marker.material.map = api.getTex(SYMBOLS[d.type] || '•', d.status === 'offline' ? '#91a1aa' : d.status === 'alert' ? '#ffc07f' : '#99e3bd');
    });
  }, [devices, layer, selectedId, signature, ready]);

  useEffect(() => {
    const api = engine.current; if (!api) return;
    const current = alerts.filter(a => !['archived', 'reviewed', 'resolved'].includes(a.status)); const ids = new Set(current.map(a => a.id));
    for (const [id, item] of api.alertObjects) if (!ids.has(id)) { api.alertLayer.remove(item.group); item.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); api.alertObjects.delete(id); }
    current.forEach((a, index) => { if (api.alertObjects.has(a.id)) return; const b = api.buildingGroups.get(a.buildingId)?.data; if (!b) return; const group = new THREE.Group(); group.position.set(b.x, .43, b.z); api.alertLayer.add(group);
      const color = ['critical', 'high'].includes(a.severity) ? 0xee8078 : 0xffac68;
      const radius = Math.max(b.width, b.depth) * .73; const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + .22, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: .5, depthWrite: false })); ring.rotation.x = -Math.PI / 2; group.add(ring);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: .06, depthWrite: false })); fill.rotation.x = -Math.PI / 2; fill.position.y = .01; group.add(fill);
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: api.getTex('!', '#' + color.toString(16)), transparent: true, depthTest: false })); marker.position.set(b.width * .46, b.height + 3.6, b.depth * .37); marker.scale.set(3.9, 3.9, 1); marker.userData = { kind: 'alert', id: a.id }; marker.renderOrder = 12; group.add(marker); api.alertObjects.set(a.id, { group, marker, ring, phase: index * .17 });
    });
    current.forEach(a => { const item = api.alertObjects.get(a.id); if (item) item.group.visible = a.id === selectedId || ['overview', 'devices', 'equipment'].includes(layer) || a.type === layer || (layer === 'security' && ['fire', 'fall', 'security'].includes(a.type)); });
  }, [alerts, layer, selectedId, signature, ready]);

  useEffect(() => {
    const api = engine.current; if (!api) return;
    for (const child of [...api.routeLayer.children]) { api.routeLayer.remove(child); child.geometry?.dispose(); child.material?.dispose(); }
    const showPatrol = ['overview', 'security'].includes(layer), showDelivery = ['overview', 'delivery'].includes(layer);
    const tasks = [...(showPatrol ? patrols.map(p => ({ ...p, kind: 'patrol', vehicleId: p.robotId })) : []), ...(showDelivery ? deliveries.map(d => ({ ...d, kind: 'delivery' })) : [])].filter(t => ACTIVE_ROUTES.includes(t.status));
    tasks.slice(0, 8).forEach(task => {
      if (drawPlannedRoute(api.routeLayer, task.routePlan, task.status === 'paused')) return;
      const routeIds = task.route?.length ? task.route : [task.from, task.to];
      const routeBuildings = routeIds.map(id => api.buildingGroups.get(id)?.data).filter(Boolean); if (routeBuildings.length < 2) return;
      const drone = devices.find(d => d.id === task.vehicleId)?.type === 'drone';
      const color = ROUTE_COLORS[task.kind];
      let points;
      if (drone) {
        const start = routeBuildings[0], end = routeBuildings[routeBuildings.length - 1];
        const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(start.x, start.height + 2, start.z), new THREE.Vector3((start.x + end.x) / 2, Math.max(start.height, end.height) + 14, (start.z + end.z) / 2), new THREE.Vector3(end.x, end.height + 2, end.z));
        points = curve.getPoints(48);
      } else {
        points = [];
        routeBuildings.forEach((b, i) => { const gateZ = b.z > 0 ? b.z - b.depth / 2 - 1.5 : b.z + b.depth / 2 + 1.5; if (i === 0) points.push(new THREE.Vector3(b.x, .5, gateZ)); points.push(new THREE.Vector3(b.x, .5, 0)); if (i > 0) { points.push(new THREE.Vector3(b.x, .5, gateZ)); if (i < routeBuildings.length - 1) points.push(new THREE.Vector3(b.x, .5, 0)); } });
      }
      drawRoute(api.routeLayer, points, color, true, task.status === 'paused');
      markRouteStop(api.routeLayer, points[0], color);
      markRouteStop(api.routeLayer, points[points.length - 1], color);
    });
  }, [patrols, deliveries, layer, signature, ready]);

  useEffect(() => {
    const api = engine.current; if (!api) return;
    api.buildingGroups.forEach((item, id) => { const selected = id === selectedId; item.outline.visible = selected; item.label.element.classList.toggle('is-selected', selected); const cut = selected && Number(floor) > 0; item.floors.forEach((fg, index) => { fg.visible = !cut || index < Number(floor); }); item.roof.visible = !cut; item.led.visible = !cut; item.label.position.y = (cut ? Math.min(Number(floor), item.data.floors) * item.data.height / item.data.floors : item.data.height) + 2.9; item.label.visible = showLabels; });
  }, [selectedId, floor, showLabels, signature, ready]);
  useEffect(() => { if (engine.current) { engine.current.reset(view === 'top'); engine.current.view = view; } }, [resetKey, view, ready]);
  useEffect(() => { if (focusTarget && engine.current) engine.current.focus(focusTarget.id, focusTarget.kind, view === 'top'); }, [focusTarget, ready]);

  return <div className="park-scene" ref={host}>
    {ready && showLabels && layer === 'delivery' && deliveries.some(d => ACTIVE_ROUTES.includes(d.status) && d.routePlan?.delivery?.points?.length) && (
      <div className="delivery-map-key"><span>前往取件</span><span>送达目的地</span></div>
    )}
    {!ready && !webglError && <div className="scene-loading-cover"><span>正在构建园区数字孪生…</span></div>}
    {webglError && <div className="scene-fallback"><svg viewBox="-80 -58 160 116" role="img" aria-label="园区二维兼容地图"><rect x="-76" y="-54" width="152" height="108" rx="6" fill="#294447"/><path d="M-70 0H65M-3 -50V50" stroke="#638e88" strokeWidth="5"/>{campus.map(b => <g key={b.id} onClick={() => onSelect?.({ kind: 'building', id: b.id })}><rect x={b.x - b.width / 2} y={b.z - b.depth / 2} width={b.width} height={b.depth} rx="1" fill={selectedId === b.id ? '#9be6c7' : '#4e8479'}/><text x={b.x} y={b.z} textAnchor="middle">{b.name}</text></g>)}</svg><p>当前设备未启用 WebGL，已切换二维兼容地图。设备与业务控制仍可使用。</p></div>}
  </div>;
}
