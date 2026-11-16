// 3D-модель прибора: корпус, плата ESP32, датчики и «живой воздух» вокруг.
// Цвет и плотность частиц зависят от показаний, по датчику можно нажать, чтобы открыть его график.
// Панель присылает показания событием eco:latest, а выбор датчика ловит из события eco:select-metric.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildDevice, canvasTexture } from './device-model.js';

const COLORS = {
    idle: new THREE.Color(0x8fd3f0),
    good: new THREE.Color(0x62d8a4),
    warn: new THREE.Color(0xf2c14e),
    danger: new THREE.Color(0xff8a7a),
    offline: new THREE.Color(0xa9b9bc),
};
const LEVEL_ORDER = { good: 0, warn: 1, danger: 2 };
const PARTICLE_COUNT = 1400;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SENSORS = [
    { id: 'esp', name: 'Плата', note: 'Собирает показания и отправляет их на сайт', metrics: [] },
    { id: 'dht', name: 'Датчик климата', note: 'Температура и влажность', metrics: ['temperature', 'humidity'] },
    { id: 'mq', name: 'Датчик газа', note: 'Углекислый газ', metrics: ['co2'] },
    { id: 'gp2y', name: 'Датчик пыли', note: 'Пыль в воздухе', metrics: ['dust'] },
];

// Подписи и единицы берём из настроек панели, а на странице входа их нет
const configElement = document.getElementById('config');
const METRICS = configElement ? JSON.parse(configElement.textContent).metrics : {};

function formatValue(metric, value) {
    const meta = METRICS[metric];
    if (!meta) return String(value);
    const number = value.toLocaleString('ru-RU', {
        minimumFractionDigits: meta.decimals, maximumFractionDigits: meta.decimals });
    return `${meta.label}: ${number} ${meta.unit}`;
}

// Свечение частиц и пола
const textures = {
    particle: () => canvasTexture(64, (ctx, s) => {
        const gradient = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, s, s);
    }),
    glow: () => canvasTexture(256, (ctx, s) => {
        const gradient = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        gradient.addColorStop(0, 'rgba(255,255,255,0.55)');
        gradient.addColorStop(0.5, 'rgba(255,255,255,0.12)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, s, s);
    }),
};

// ---------- Частицы воздуха ----------
function buildParticles() {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const speeds = new Float32Array(PARTICLE_COUNT);
    const phases = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        const radius = 1.2 + Math.random() * 3.6;
        const angle = Math.random() * Math.PI * 2;
        positions[i * 3] = Math.cos(angle) * radius;
        positions[i * 3 + 1] = -0.6 + Math.random() * 4.6;
        positions[i * 3 + 2] = Math.sin(angle) * radius;
        speeds[i] = 0.4 + Math.random();
        phases[i] = Math.random() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 0.17, map: textures.particle(), color: COLORS.idle, transparent: true,
        // Обычное смешивание: при сложении цветов частицы пропадали бы на светлом фоне
        opacity: 0.9, depthWrite: false, sizeAttenuation: true,
        toneMapped: false, // иначе яркие частицы выцветают почти до белого
    }));
    points.userData = { speeds, phases };
    return points;
}

// ---------- Сцена ----------
class DeviceScene {
    constructor(container) {
        this.container = container;
        this.demo = container.dataset.scene3d === 'demo';
        this.levels = {};
        this.values = {};
        this.selectedMetric = null;
        this.hovered = null;
        this.targetColor = COLORS.idle.clone();
        this.energy = 0.35; // 0..1: насколько быстро и густо движется воздух
        this.lastReadingTime = null;
        this.ledFlash = 0;
        this.clock = new THREE.Clock();
        this.running = false;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.prepend(this.renderer.domElement);

        this.scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

        this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
        this.camera.position.set(5.5, 4.0, 6.5);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0.6, 0);
        this.controls.enableDamping = true;
        this.controls.enableZoom = false;
        this.controls.enablePan = false;
        this.controls.minPolarAngle = 0.55;
        this.controls.maxPolarAngle = 1.35;
        this.controls.autoRotate = !REDUCED_MOTION;
        this.controls.autoRotateSpeed = 0.9;

        this.addLights();
        const { device, sensors } = buildDevice(SENSORS);
        this.device = device;
        this.sensors = sensors;
        this.scene.add(device);
        device.position.y = -1.2;
        device.scale.setScalar(0.85);

        this.particles = buildParticles();
        this.scene.add(this.particles);

        this.floorGlow = new THREE.Mesh(new THREE.CircleGeometry(3.2, 64), new THREE.MeshBasicMaterial({
            map: textures.glow(), color: COLORS.idle, transparent: true, depthWrite: false }));
        this.floorGlow.rotation.x = -Math.PI / 2;
        this.floorGlow.position.y = -0.16;
        this.scene.add(this.floorGlow);

        const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(14, 14),
            new THREE.ShadowMaterial({ opacity: 0.35 }));
        shadowCatcher.rotation.x = -Math.PI / 2;
        shadowCatcher.position.y = -0.15;
        shadowCatcher.receiveShadow = true;
        this.scene.add(shadowCatcher);

        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.tip = container.querySelector('.scene-tip');
        this.bindEvents();
        this.resize();
        this.introStart = performance.now();

        // Страница могла получить показания раньше, чем загрузилась модель: берём их сразу
        if (window.ecoLatest) {
            this.onLatest(window.ecoLatest);
        } else if (this.demo) {
            this.applyLevels({ temperature: 'good', humidity: 'good', co2: 'good', dust: 'good' }, 'good');
        }
        if (!this.demo) {
            const pressed = document.querySelector('.reading[aria-pressed="true"]');
            this.selectedMetric = pressed ? pressed.dataset.metric : null;
        }
        container.classList.add('scene-ready');
    }

    addLights() {
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(4, 7, 3);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.left = -4;
        key.shadow.camera.right = 4;
        key.shadow.camera.top = 4;
        key.shadow.camera.bottom = -4;
        key.shadow.radius = 4;
        const rim = new THREE.DirectionalLight(0x8fd3f0, 1.4);
        rim.position.set(-5, 3, -4);
        this.scene.add(key, rim, new THREE.AmbientLight(0x406070, 0.6));
    }

    bindEvents() {
        new ResizeObserver(() => this.resize()).observe(this.container);
        // Рисуем только когда сцену видно: так страница не грузит процессор зря
        new IntersectionObserver(([entry]) => {
            this.visible = entry.isIntersecting;
            this.updateRunning();
        }).observe(this.container);
        document.addEventListener('visibilitychange', () => this.updateRunning());

        const canvas = this.renderer.domElement;
        canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        canvas.addEventListener('pointerleave', () => this.setHovered(null));
        let downAt = null;
        canvas.addEventListener('pointerdown', (event) => { downAt = [event.clientX, event.clientY]; });
        canvas.addEventListener('pointerup', (event) => {
            // Перетаскивание крутит модель, а короткое нажатие выбирает датчик
            if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) < 6) {
                this.onPointerMove(event);
                this.selectHovered();
            }
            downAt = null;
        });

        window.addEventListener('eco:latest', (event) => this.onLatest(event.detail));
        window.addEventListener('eco:metric', (event) => {
            this.selectedMetric = event.detail.metric;
        });
    }

    updateRunning() {
        const shouldRun = this.visible && !document.hidden;
        if (shouldRun && !this.running) {
            this.running = true;
            this.clock.getDelta();
            this.renderer.setAnimationLoop(() => this.frame());
        } else if (!shouldRun && this.running) {
            this.running = false;
            this.renderer.setAnimationLoop(null);
        }
    }

    resize() {
        const { clientWidth: width, clientHeight: height } = this.container;
        if (!width || !height) return;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        // На узком экране отодвигаем камеру, чтобы прибор помещался целиком
        this.camera.zoom = Math.min(1, width / height / 1.1);
        this.camera.updateProjectionMatrix();
    }

    onLatest(data) {
        if (!data || !data.levels) {
            this.applyLevels({}, data && Object.keys(data).length ? 'unknown' : 'idle');
            return;
        }
        const levels = {};
        for (const [metric, zone] of Object.entries(data.levels)) levels[metric] = zone.level;
        this.values = {};
        for (const metric of Object.keys(METRICS)) {
            if (data[metric] !== null && data[metric] !== undefined) this.values[metric] = data[metric];
        }
        this.applyLevels(levels, data.online ? data.summary.level : 'offline');

        // Энергия воздуха: чем больше CO₂ и пыли, тем гуще и беспокойнее частицы
        const share = (metric) => {
            const meta = METRICS[metric];
            if (!meta || this.values[metric] === undefined) return 0.3;
            const [low, high] = meta.scale;
            return Math.min(Math.max((this.values[metric] - low) / (high - low), 0), 1);
        };
        this.energy = 0.2 + 0.4 * share('co2') + 0.4 * share('dust');

        if (data.created_at !== this.lastReadingTime) {
            if (this.lastReadingTime !== null) this.ledFlash = 1;
            this.lastReadingTime = data.created_at;
        }
    }

    applyLevels(levels, summaryLevel) {
        this.levels = levels;
        this.offline = summaryLevel === 'offline';
        this.targetColor = (COLORS[summaryLevel] || COLORS.offline).clone();
        for (const group of Object.values(this.sensors)) {
            const { metrics } = group.userData.sensor;
            const known = metrics.filter((metric) => levels[metric]);
            const ring = group.userData.ring;
            ring.visible = known.length > 0;
            if (!known.length) continue;
            const worst = known.reduce((a, b) => (LEVEL_ORDER[levels[a]] >= LEVEL_ORDER[levels[b]] ? a : b));
            ring.material.color.copy(this.offline ? COLORS.offline : COLORS[levels[worst]]);
        }
    }

    onPointerMove(event) {
        const box = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((event.clientX - box.left) / box.width) * 2 - 1,
            -((event.clientY - box.top) / box.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(Object.values(this.sensors), true);
        let group = null;
        for (const hit of hits) {
            let node = hit.object;
            while (node && !node.userData.sensor) node = node.parent;
            if (node && node.userData.ring !== hit.object) {
                group = node;
                break;
            }
        }
        this.setHovered(group);
    }

    setHovered(group) {
        if (this.hovered === group) return;
        this.hovered = group;
        this.controls.autoRotate = !REDUCED_MOTION && !group;
        const clickable = group && group.userData.sensor.metrics.length && !this.demo;
        this.renderer.domElement.style.cursor = clickable ? 'pointer' : '';
        if (!group) {
            this.tip.hidden = true;
            return;
        }
        const { name, note, metrics } = group.userData.sensor;
        const lines = metrics.filter((metric) => this.values[metric] !== undefined)
            .map((metric) => formatValue(metric, this.values[metric]));
        this.tip.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = name;
        this.tip.append(title);
        for (const text of [note, ...lines]) {
            const line = document.createElement('span');
            line.textContent = text;
            this.tip.append(line);
        }
        if (clickable) {
            const hint = document.createElement('em');
            hint.textContent = 'Нажмите, чтобы открыть график';
            this.tip.append(hint);
        }
        this.tip.hidden = false;
    }

    selectHovered() {
        if (!this.hovered || this.demo) return;
        const { metrics } = this.hovered.userData.sensor;
        if (!metrics.length) return;
        // У DHT22 два показателя: повторное нажатие переключает между ними
        const current = metrics.indexOf(this.selectedMetric);
        const metric = metrics[(current + 1) % metrics.length];
        window.dispatchEvent(new CustomEvent('eco:select-metric', { detail: { metric } }));
    }

    placeTip() {
        if (!this.hovered || this.tip.hidden) return;
        const point = new THREE.Vector3();
        this.hovered.getWorldPosition(point);
        point.y += 1.1;
        point.project(this.camera);
        const { clientWidth: width, clientHeight: height } = this.container;
        const x = (point.x + 1) / 2 * width;
        const y = (1 - point.y) / 2 * height;
        const tipWidth = this.tip.offsetWidth;
        this.tip.style.left = `${Math.min(Math.max(x - tipWidth / 2, 8), width - tipWidth - 8)}px`;
        this.tip.style.top = `${Math.max(y - this.tip.offsetHeight, 8)}px`;
    }

    frame() {
        const delta = Math.min(this.clock.getDelta(), 0.05);
        const time = this.clock.elapsedTime;

        // Появление: прибор поднимается и чуть увеличивается
        const intro = Math.min((performance.now() - this.introStart) / 1400, 1);
        const eased = 1 - (1 - intro) ** 3;
        this.device.position.y = -1.2 * (1 - eased) + (REDUCED_MOTION ? 0 : Math.sin(time * 0.8) * 0.05);
        this.device.scale.setScalar(0.85 + 0.15 * eased);

        // Плавно перекрашиваем воздух и подсветку пола
        // Скорость перехода не зависит от частоты кадров: за секунду проходит около 90% пути
        const blend = 1 - Math.exp(-delta * 2.5);
        const air = this.particles.material;
        air.color.lerp(this.targetColor, blend);
        air.opacity = this.offline ? 0.35 : 0.85;
        this.floorGlow.material.color.lerp(this.targetColor, blend);
        this.floorGlow.material.opacity = 0.55 + Math.sin(time * 1.6) * 0.12;

        // Частицы поднимаются вверх, тем быстрее, чем хуже воздух
        const speed = this.offline || REDUCED_MOTION ? 0.08 : 0.15 + this.energy * 0.6;
        const visibleCount = Math.round(PARTICLE_COUNT * (0.3 + this.energy * 0.7));
        this.particles.geometry.setDrawRange(0, visibleCount);
        const positions = this.particles.geometry.attributes.position.array;
        const { speeds, phases } = this.particles.userData;
        for (let i = 0; i < visibleCount; i += 1) {
            const k = i * 3;
            positions[k + 1] += speeds[i] * speed * delta;
            positions[k] += Math.sin(time * 0.7 + phases[i]) * 0.12 * delta * (0.5 + this.energy);
            positions[k + 2] += Math.cos(time * 0.6 + phases[i]) * 0.12 * delta * (0.5 + this.energy);
            if (positions[k + 1] > 4) positions[k + 1] = -0.6;
        }
        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.rotation.y += delta * 0.05 * (1 + this.energy);

        // Кольца статуса: выбранный датчик и тот, что под курсором, светятся ярче
        for (const group of Object.values(this.sensors)) {
            const ring = group.userData.ring;
            const active = group === this.hovered
                || group.userData.sensor.metrics.includes(this.selectedMetric);
            const pulse = 1 + Math.sin(time * 2.5 + group.position.x) * 0.04;
            const target = (active ? 1.18 : 1) * pulse;
            ring.scale.lerp(new THREE.Vector3(target, target, target), 0.15);
            ring.material.opacity = active ? 1 : 0.55;
            const lift = group === this.hovered ? 0.08 : 0;
            group.position.y += ((group.userData.baseY ??= group.position.y) + lift - group.position.y) * 0.2;
        }

        // Светодиод ESP32 мигает, когда приходят новые показания
        const led = this.sensors.esp.userData.led;
        this.ledFlash = Math.max(this.ledFlash - delta * 1.5, 0);
        led.material.emissiveIntensity = 0.4 + this.ledFlash * 4 + (this.demo ? Math.max(Math.sin(time * 3), 0) * 2 : 0);

        this.controls.update();
        this.placeTip();
        this.renderer.render(this.scene, this.camera);
    }
}

for (const container of document.querySelectorAll('[data-scene3d]')) {
    try {
        new DeviceScene(container);
    } catch (error) {
        // Без WebGL сайт работает как раньше, просто без модели
        console.warn('3D-сцена недоступна:', error);
        container.classList.add('scene-failed');
    }
}
