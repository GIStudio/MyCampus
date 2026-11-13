import * as THREE from 'three';
import './styles.css';
import { CAMPUSES, loadCampus } from './data';
import { RoamingController } from './controls';
import { CampusMinimap } from './minimap';
import type { CampusData, CampusDefinition } from './types';
import { CampusWorld } from './world';

type AppState = 'loading' | 'ready' | 'playing' | 'error';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少 #app 挂载节点');

app.innerHTML = `
  <main class="experience" aria-label="MyCampus 双校区 3D 漫游">
    <div id="viewport" class="viewport"></div>
    <div class="ambient-glow" aria-hidden="true"></div>

    <header class="topbar">
      <a class="brand" href="#" aria-label="MyCampus 首页">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><strong>MyCampus</strong><small>双校园 · 自由漫游</small></span>
      </a>
      <nav class="campus-switch" aria-label="切换校区">
        ${CAMPUSES.map((campus, index) => `
          <button type="button" class="campus-button${index === 0 ? ' active' : ''}" data-campus="${campus.id}" aria-pressed="${index === 0}">
            <span class="campus-dot" aria-hidden="true"></span>${campus.shortName}
          </button>
        `).join('')}
      </nav>
      <div class="topbar-meta">
        <div class="campus-status">
          <span id="current-campus">香港科技大学（清水湾）</span>
          <span class="status-line"><i id="status-dot"></i><span id="status-text" role="status">正在载入</span></span>
        </div>
        <details class="data-details">
          <summary>数据说明</summary>
          <div class="data-popover">
            <strong>关于校园数据</strong>
            <p>建筑、道路、绿地、水面与树木来自本地 OSM 快照。高度缺失时按层数或建筑类型估算；林地与广州校区的部分树木为程序示意，地形采用平面，不作为精确测绘依据。</p>
            <p id="data-stats">正在等待校区数据。</p>
            <p id="height-sources"></p>
            <span>树木 GLB 不可用时会自动使用低模树，不影响漫游。</span>
          </div>
        </details>
      </div>
    </header>

    <section class="minimap-panel" aria-label="校园小地图">
      <div class="panel-heading">
        <span>校园导览</span>
        <div class="map-heading-actions">
          <span class="north"><b>↑</b> N</span>
          <button id="expand-map" class="map-toggle-button" type="button" aria-label="展开校园地图" aria-expanded="false" aria-controls="campus-map-dialog">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4"/></svg>
            <span>展开</span>
          </button>
        </div>
      </div>
      <div id="minimap-home">
        <div id="map-content" class="map-content">
          <div class="map-wrap"><canvas id="minimap" aria-label="显示建筑、道路和当前位置的小地图"></canvas></div>
          <div class="map-caption"><span><i></i>当前位置</span><span id="map-campus">清水湾</span></div>
        </div>
      </div>
    </section>

    <dialog id="campus-map-dialog" class="map-dialog" aria-labelledby="map-dialog-title">
      <div class="map-dialog-header">
        <div class="map-dialog-heading">
          <h2 id="map-dialog-title">清水湾校园地图</h2>
          <span class="north"><b>↑</b> N</span>
        </div>
        <nav class="campus-switch map-dialog-switch" aria-label="在大地图中切换校区">
          ${CAMPUSES.map((campus, index) => `
            <button type="button" class="campus-button${index === 0 ? ' active' : ''}" data-campus="${campus.id}" aria-pressed="${index === 0}">
              <span class="campus-dot" aria-hidden="true"></span>${campus.shortName}
            </button>
          `).join('')}
        </nav>
        <button id="collapse-map" class="map-toggle-button map-collapse-button" type="button" aria-label="收起校园大地图" aria-controls="campus-map-dialog" autofocus>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7h4V3M17 7h-4V3M3 13h4v4M17 13h-4v4"/></svg>
          <span>收起</span>
        </button>
      </div>
      <div id="map-dialog-body" class="map-dialog-body"></div>
    </dialog>

    <div class="control-hints" aria-label="操作提示">
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动</span>
      <span><span class="mouse-icon" aria-hidden="true"></span> 鼠标环视</span>
      <span><kbd>Shift</kbd> 加速</span>
      <span><kbd>Space</kbd> 跳跃</span>
      <span><kbd>R</kbd> 回起点</span>
      <span><kbd>Esc</kbd> 释放鼠标</span>
    </div>

    <div id="crosshair" class="crosshair" aria-hidden="true"></div>
    <div id="notice" class="notice" role="status" hidden></div>

    <section id="start-screen" class="center-overlay" aria-labelledby="start-title" hidden>
      <div class="start-card">
        <span class="eyebrow">HKUST · DUAL CAMPUS</span>
        <h1 id="start-title">走进校园，换一种视角</h1>
        <p id="start-description">在清水湾的山海之间，开始一段自由漫游。</p>
        <button id="start-button" class="primary-button" type="button">
          <span>点击进入漫游</span><span aria-hidden="true">↗</span>
        </button>
        <div class="start-note"><span class="key-cluster"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>相对镜头移动 · Esc 可随时暂停</span></div>
      </div>
    </section>

    <section id="loading-screen" class="center-overlay" aria-label="加载状态">
      <div class="loading-card">
        <span class="loader" aria-hidden="true"></span>
        <div><strong id="loading-title">正在载入清水湾</strong><p id="loading-detail">读取校园数据与空间边界…</p></div>
      </div>
    </section>

    <section id="error-screen" class="center-overlay" aria-labelledby="error-title" hidden>
      <div class="error-card" role="alert">
        <span class="error-symbol" aria-hidden="true">!</span>
        <span class="eyebrow">漫游暂未就绪</span>
        <h2 id="error-title">校园资源加载失败</h2>
        <p id="error-message">请检查资源后重试。</p>
        <button id="retry-button" class="primary-button" type="button">重新加载</button>
      </div>
    </section>

    <footer class="attribution">
      校园空间数据 <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
    </footer>
  </main>
`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素 #${id}`);
  return node as T;
}

const viewport = element('viewport');
const startScreen = element('start-screen');
const loadingScreen = element('loading-screen');
const errorScreen = element('error-screen');
const startButton = element<HTMLButtonElement>('start-button');
const retryButton = element<HTMLButtonElement>('retry-button');
const statusText = element('status-text');
const statusDot = element('status-dot');
const currentCampus = element('current-campus');
const mapCampus = element('map-campus');
const notice = element('notice');
const minimap = new CampusMinimap(element<HTMLCanvasElement>('minimap'));
const minimapHome = element('minimap-home');
const mapContent = element('map-content');
const mapDialog = element<HTMLDialogElement>('campus-map-dialog');
const mapDialogBody = element('map-dialog-body');
const expandMapButton = element<HTMLButtonElement>('expand-map');
const collapseMapButton = element<HTMLButtonElement>('collapse-map');
const campusButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-campus]')];

let renderer: THREE.WebGLRenderer | null = null;
let world: CampusWorld | null = null;
let controller: RoamingController | null = null;
let state: AppState = 'loading';
let selected = CAMPUSES[0];
let loadedCampus: CampusData | null = null;
let loadSequence = 0;
let abortController: AbortController | null = null;
let contextLost = false;
let noticeTimer = 0;
const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.08, 3200);
const clock = new THREE.Clock();

function setState(next: AppState): void {
  state = next;
  document.body.dataset.state = next;
  startScreen.hidden = next !== 'ready';
  loadingScreen.hidden = next !== 'loading';
  errorScreen.hidden = next !== 'error';
  statusDot.className = next;
  statusText.textContent = next === 'loading'
    ? '正在载入'
    : next === 'playing'
      ? '漫游中'
      : next === 'error'
        ? '需要重试'
        : '已就绪';
}

function showNotice(message: string): void {
  window.clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = false;
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 4200);
}

function updateCampusUI(definition: CampusDefinition, data?: CampusData): void {
  currentCampus.textContent = definition.name;
  mapCampus.textContent = definition.shortName;
  element('map-dialog-title').textContent = `${definition.shortName}校园地图`;
  campusButtons.forEach((button) => {
    const active = button.dataset.campus === definition.id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (!data) return;
  element('data-stats').textContent = `${data.buildings.length} 栋建筑记录 · ${data.roads.length} 条道路 · ${data.trees.length} 处树木位置`;
  const sources = [...new Set(data.buildings.map((building) => building.heightSource).filter(Boolean))];
  const sourceLabels: Record<string, string> = { osm: 'OSM 高度', levels: '层数估算', estimated: '类型默认值' };
  element('height-sources').textContent = sources.length > 0
    ? `建筑高度来源：${sources.map((source) => sourceLabels[source] ?? source).join('、')}`
    : '建筑高度来源见原始数据。';
  element('start-description').textContent = definition.id === 'clear-water-bay'
    ? '在清水湾的山海之间，穿过象牙白建筑与蓝绿树影。'
    : '沿着广州校区的轴线，在建筑、庭院与水岸间自由探索。';
}

function setupRenderer(): void {
  const nextRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  nextRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  nextRenderer.setSize(window.innerWidth, window.innerHeight);
  nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
  nextRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  nextRenderer.toneMappingExposure = 1.03;
  nextRenderer.shadowMap.enabled = true;
  nextRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  nextRenderer.domElement.id = 'campus-canvas';
  nextRenderer.domElement.tabIndex = 0;
  nextRenderer.domElement.setAttribute('aria-label', '校园三维漫游画面，点击进入后使用 WASD 移动');
  viewport.replaceChildren(nextRenderer.domElement);
  nextRenderer.domElement.addEventListener('click', () => {
    if (state === 'ready') void controller?.requestPlaying();
  });
  nextRenderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    if (document.pointerLockElement) document.exitPointerLock();
    showError('图形上下文已中断。点击“重新加载”即可恢复漫游。', '图形资源需要恢复');
  });
  renderer = nextRenderer;
  contextLost = false;
}

function showError(message: string, title = '校园资源加载失败'): void {
  element('error-title').textContent = title;
  element('error-message').textContent = message;
  setState('error');
  if (mapDialog.open) mapDialog.close();
}

function openMap(): void {
  if (mapDialog.open) return;
  if (document.pointerLockElement) document.exitPointerLock();
  mapDialogBody.append(mapContent);
  expandMapButton.setAttribute('aria-expanded', 'true');
  mapDialog.showModal();
  minimap.resize();
}

mapDialog.addEventListener('close', () => {
  if (mapDialog.open) return;
  minimapHome.append(mapContent);
  expandMapButton.setAttribute('aria-expanded', 'false');
  minimap.resize();
  if (state === 'error') retryButton.focus({ preventScroll: true });
  else expandMapButton.focus({ preventScroll: true });
});

mapDialog.addEventListener('click', (event) => {
  if (event.target !== mapDialog) return;
  const bounds = mapDialog.getBoundingClientRect();
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
    && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  if (!inside) mapDialog.close();
});

expandMapButton.addEventListener('click', openMap);
collapseMapButton.addEventListener('click', () => mapDialog.close());

async function selectCampus(definition: CampusDefinition): Promise<void> {
  selected = definition;
  updateCampusUI(definition);
  const sequence = ++loadSequence;
  abortController?.abort();
  abortController = new AbortController();
  if (document.pointerLockElement) document.exitPointerLock();
  setState('loading');
  element('loading-title').textContent = `正在载入${definition.shortName}`;
  element('loading-detail').textContent = '读取校园数据与空间边界…';
  notice.hidden = true;

  world?.dispose();
  world = null;
  loadedCampus = null;

  try {
    const data = await loadCampus(definition, abortController.signal);
    if (sequence !== loadSequence) return;
    element('loading-detail').textContent = '构建建筑、道路与景观…';
    const nextWorld = new CampusWorld(data);
    await nextWorld.buildTrees();
    if (sequence !== loadSequence) {
      nextWorld.dispose();
      return;
    }
    world = nextWorld;
    loadedCampus = data;
    if (controller) {
      controller.setWorld(nextWorld);
      nextWorld.scene.add(controller.avatar.group);
    } else {
      if (!renderer) throw new Error('WebGL 渲染器尚未初始化');
      controller = new RoamingController(
        camera,
        renderer.domElement,
        nextWorld,
        (playing) => {
          if (state !== 'loading' && state !== 'error') setState(playing ? 'playing' : 'ready');
        },
        () => {
          if (state === 'playing' || state === 'ready') {
            setState('ready');
            showNotice('鼠标未能锁定，请再次点击“进入漫游”。');
          }
        },
      );
      nextWorld.scene.add(controller.avatar.group);
    }
    minimap.setData(data);
    updateCampusUI(definition, data);
    if (world.stats.fallbackTrees > 0) {
      showNotice(`部分树木模型不可用，已为 ${world.stats.fallbackTrees} 处位置使用低模树。`);
    }
    setState('ready');
  } catch (error) {
    if (sequence !== loadSequence || abortController.signal.aborted) return;
    const message = error instanceof Error ? error.message : '未知资源错误';
    showError(message);
  }
}

startButton.addEventListener('click', () => {
  if (state === 'ready') void controller?.requestPlaying();
});

retryButton.addEventListener('click', () => {
  if (!renderer || contextLost) {
    controller?.dispose();
    controller = null;
    renderer?.dispose();
    renderer?.domElement.remove();
    renderer = null;
    world?.dispose();
    world = null;
    try {
      setupRenderer();
      startAnimation();
    } catch (error) {
      showError(error instanceof Error ? error.message : '当前浏览器无法创建 WebGL 场景。', '无法启动 3D 漫游');
      return;
    }
  }
  void selectCampus(selected);
});

campusButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const definition = CAMPUSES.find((campus) => campus.id === button.dataset.campus);
    if (!definition) return;
    if (definition.id === selected.id && loadedCampus && state !== 'error') {
      if (document.pointerLockElement) document.exitPointerLock();
      else if (!mapDialog.open && state === 'ready') void controller?.requestPlaying();
      return;
    }
    void selectCampus(definition);
  });
});

document.querySelector('.brand')?.addEventListener('click', (event) => {
  event.preventDefault();
  controller?.reset(true);
  if (document.pointerLockElement) document.exitPointerLock();
  if (world) setState('ready');
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer?.setSize(window.innerWidth, window.innerHeight);
  minimap.resize();
});

let frame = 0;
let animationStarted = false;
function startAnimation(): void {
  if (animationStarted) return;
  animationStarted = true;
  animate();
}

function animate(): void {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (!world || !controller || !renderer || state === 'loading' || state === 'error') return;
  controller.update(delta);
  world.updateFocus(controller.avatar.group.position, camera);
  if (frame % 3 === 0) {
    minimap.update(
      controller.avatar.group.position.x,
      controller.avatar.group.position.z,
      controller.avatar.group.rotation.y,
    );
  }
  frame += 1;
  renderer.render(world.scene, camera);
}

try {
  setupRenderer();
  startAnimation();
  void selectCampus(selected);
} catch (error) {
  setState('error');
  showError(error instanceof Error ? error.message : '当前浏览器不支持 WebGL。', '无法启动 3D 漫游');
}
