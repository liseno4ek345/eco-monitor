// Детальная 3D-модель прибора: корпус, плата, ESP32 DevKit, DHT22, MQ-135, GP2Y1010 и провода.
// Всё собрано из простых фигур и текстур, нарисованных на canvas, поэтому файлов моделей не нужно.
// Размеры примерные, 1 единица сцены примерно равна 2,5 см.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const PCB_TOP = 0.205; // верх основной платы
const RING_COLOR = 0x8fd3f0;

export function canvasTexture(size, draw, height = size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = height;
    draw(canvas.getContext('2d'), size, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
}

// Случайные числа с постоянным зерном: мелкие детали стоят на одних и тех же местах
function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------- Материалы ----------
function standard(color, roughness = 0.5, metalness = 0, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

function glowing(color, intensity = 1.5) {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity });
}

const MAT = {
    pcbDark: standard(0x1d2b33, 0.7),
    pcbBlue: standard(0x1b4fa0, 0.55),
    module: standard(0x24343c, 0.6),
    black: standard(0x16191c, 0.55),
    blackGloss: standard(0x0b0c0e, 0.3),
    hole: standard(0x040505, 1),
    gold: standard(0xd4a640, 0.3, 1),
    silver: standard(0xd5dadc, 0.28, 1),
    brass: standard(0xc9a14a, 0.35, 1),
    solder: standard(0xc0c4c6, 0.4, 0.9),
    white: standard(0xf1f3f0, 0.6),
    tan: standard(0xc8a27a, 0.6),
    bakelite: standard(0xa8551e, 0.5),
    potBlue: standard(0x2a5bd7, 0.45),
    capBlue: standard(0x1d3f8a, 0.4),
    resistor: standard(0xd9c08e, 0.55),
    cable: standard(0x2a2e33, 0.6),
    caseBase: standard(0x16303a, 0.35, 0.6),
};

// ---------- Текстуры ----------
const TEXTURES = {
    // Решётка DHT22: прорези с тенью сверху, чтобы казались углублёнными
    grille: () => canvasTexture(256, (ctx, w, h) => {
        ctx.fillStyle = '#eef2ef';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#d3d9d6';
        ctx.lineWidth = 8;
        ctx.strokeRect(10, 10, w - 20, h - 20);
        for (let row = 0; row < 8; row += 1) {
            for (let col = 0; col < 5; col += 1) {
                const x = 30 + col * 42;
                const y = 26 + row * 31;
                ctx.fillStyle = '#6f7c79';
                ctx.fillRect(x, y, 28, 17);
                ctx.fillStyle = '#323b39';
                ctx.fillRect(x, y, 28, 7);
            }
        }
    }, 320),
    // Металлическая сетка MQ-135
    mesh: () => {
        const texture = canvasTexture(128, (ctx, w) => {
            ctx.fillStyle = '#c3cbcd';
            ctx.fillRect(0, 0, w, w);
            ctx.fillStyle = '#4f585a';
            for (let y = 4; y < w; y += 8) {
                for (let x = (y / 8) % 2 ? 8 : 4; x < w; x += 8) {
                    ctx.beginPath();
                    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        return texture;
    },
    // Экран модуля ESP32 с гравировкой
    shield: () => canvasTexture(256, (ctx, w, h) => {
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#e4e8ea');
        gradient.addColorStop(1, '#aeb6ba');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#6b7478';
        ctx.font = 'bold 26px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('WI-FI MODULE', w / 2, 92);
        ctx.font = '20px Consolas, monospace';
        ctx.fillText('Wi-Fi + Bluetooth', w / 2, 128);
        ctx.fillText('240 MHz  4 MB', w / 2, 158);
        ctx.strokeStyle = '#7d878b';
        ctx.lineWidth = 3;
        ctx.strokeRect(20, 190, 44, 44);
        ctx.fillRect(28, 198, 10, 10);
        ctx.fillRect(46, 216, 10, 10);
    }, 270),
    // Антенна-змейка на конце модуля
    antenna: () => canvasTexture(256, (ctx, w, h) => {
        ctx.fillStyle = '#1e2c33';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#d4a640';
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(14, h - 10);
        for (let x = 14, up = true; x < w - 20; x += 26, up = !up) {
            ctx.lineTo(x, up ? 14 : h - 14);
            ctx.lineTo(x + 26, up ? 14 : h - 14);
        }
        ctx.stroke();
    }, 100),
    label: (text) => canvasTexture(256, (ctx, w, h) => {
        ctx.fillStyle = '#1a1d20';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#e6e6e6';
        ctx.font = 'bold 30px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, w / 2, h / 2 + 10);
    }, 96),
    // Основная плата: дорожки, контактные площадки, рамки под модули и подписи
    pcb: () => canvasTexture(1024, (ctx, w, h) => {
        const rng = seededRandom(7);
        // Перевод координат сцены в пиксели: плата 4 × 2,6
        const px = (x) => ((x + 2) / 4) * w;
        const pz = (z) => ((z + 1.3) / 2.6) * h;
        ctx.fillStyle = '#0f4d3d';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(120, 210, 160, 0.32)';
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        for (let i = 0; i < 34; i += 1) {
            let x = rng() * w;
            let y = rng() * h;
            ctx.beginPath();
            ctx.moveTo(x, y);
            for (let k = 0; k < 4; k += 1) {
                const step = (rng() - 0.5) * 260;
                if (k % 2) x += step;
                else y += step;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.fillStyle = '#c9a85a';
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#0f4d3d';
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 3;
        ctx.font = 'bold 22px Consolas, monospace';
        const outlines = [
            ['U1  MCU', -1.35, 0, 1.15, 2.15],
            ['U2  T / RH', -0.15, -0.6, 0.85, 0.65],
            ['U3  GAS', 0.3, 0.6, 1.0, 1.3],
            ['U4  DUST', 1.25, -0.35, 1.45, 0.8],
        ];
        for (const [text, x, z, width, depth] of outlines) {
            ctx.strokeRect(px(x - width / 2), pz(z - depth / 2), (width / 4) * w, (depth / 2.6) * h);
            ctx.fillText(text, px(x - width / 2) + 6, pz(z + depth / 2) + 24);
        }
        ctx.font = 'bold 34px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText('ECO-MONITOR  v1.0', w - 30, h - 26);
        ctx.font = '22px Consolas, monospace';
        ctx.fillText('Инженерный класс', w - 30, h - 64);
    }, 666),
};

// ---------- Простые детали ----------
function mesh(geometry, material, x = 0, y = 0, z = 0) {
    const result = new THREE.Mesh(geometry, material);
    result.position.set(x, y, z);
    result.castShadow = true;
    result.receiveShadow = true;
    return result;
}

function box(width, height, depth, material, x, y, z) {
    return mesh(new THREE.BoxGeometry(width, height, depth), material, x, y, z);
}

function roundBox(width, height, depth, radius, material, x, y, z) {
    return mesh(new RoundedBoxGeometry(width, height, depth, 2, radius), material, x, y, z);
}

function cylinder(radius, height, material, x, y, z, segments = 24) {
    return mesh(new THREE.CylinderGeometry(radius, radius, height, segments), material, x, y, z);
}

// Винт с прорезью под отвёртку
function screw(x, y, z, radius = 0.06) {
    const group = new THREE.Group();
    group.add(cylinder(radius, 0.025, MAT.silver, 0, 0.012, 0));
    group.add(box(radius * 1.6, 0.01, radius * 0.25, MAT.blackGloss, 0, 0.026, 0));
    group.position.set(x, y, z);
    group.rotation.y = x * 3 + z * 5; // у каждого винта прорезь повёрнута по-своему
    return group;
}

// Штыревой разъём: чёрная планка и позолоченные штырьки (одним InstancedMesh, это быстрее)
function pinHeader(count, pitch = 0.1) {
    const group = new THREE.Group();
    const length = count * pitch;
    group.add(box(length, 0.06, pitch, MAT.black, 0, 0.03, 0));
    const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.022, 0.16, 0.022), MAT.gold, count);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i += 1) {
        pins.setMatrixAt(i, matrix.makeTranslation(-length / 2 + pitch * (i + 0.5), 0.1, 0));
    }
    pins.castShadow = true;
    group.add(pins);
    return group;
}

// Микросхема с выводами по двум сторонам
function chip(width, depth, legsPerSide, x, y, z) {
    const group = new THREE.Group();
    group.add(box(width, 0.04, depth, MAT.blackGloss, 0, 0.03, 0));
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.02, 0.05), MAT.solder, legsPerSide * 2);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < legsPerSide; i += 1) {
        const lx = -width / 2 + (width / legsPerSide) * (i + 0.5);
        legs.setMatrixAt(i * 2, matrix.makeTranslation(lx, 0.015, depth / 2 + 0.02));
        legs.setMatrixAt(i * 2 + 1, matrix.makeTranslation(lx, 0.015, -depth / 2 - 0.02));
    }
    group.add(legs);
    // Точка-метка первого вывода
    group.add(cylinder(0.012, 0.004, MAT.solder, -width / 2 + 0.03, 0.051, depth / 2 - 0.03, 10));
    group.position.set(x, y, z);
    return group;
}

// Мелкие SMD-резисторы и конденсаторы в прямоугольнике [x0, x1] × [z0, z1]
function scatterSmd(group, rng, count, [x0, x1, z0, z1], y) {
    for (let i = 0; i < count; i += 1) {
        const part = new THREE.Group();
        part.add(box(0.05, 0.022, 0.034, rng() < 0.5 ? MAT.black : MAT.tan, 0, 0.011, 0));
        part.add(box(0.014, 0.024, 0.036, MAT.solder, -0.03, 0.012, 0));
        part.add(box(0.014, 0.024, 0.036, MAT.solder, 0.03, 0.012, 0));
        part.position.set(x0 + rng() * (x1 - x0), y, z0 + rng() * (z1 - z0));
        part.rotation.y = rng() < 0.5 ? 0 : Math.PI / 2;
        group.add(part);
    }
}

function smdLed(color, x, y, z) {
    return box(0.05, 0.025, 0.035, glowing(color), x, y, z);
}

// ---------- Модули ----------
function buildEsp(rng) {
    const group = new THREE.Group();
    group.add(roundBox(1.0, 0.05, 2.0, 0.02, MAT.pcbDark, 0, 0.025, 0));

    // Модуль WROOM: подложка, антенна и металлический экран с надписью
    group.add(box(0.72, 0.03, 1.12, MAT.module, 0, 0.065, -0.38));
    group.add(box(0.7, 0.004, 0.28, standard(0xffffff, 0.5, 0, { map: TEXTURES.antenna() }), 0, 0.082, -0.79));
    const shieldTop = standard(0xffffff, 0.3, 0.9, { map: TEXTURES.shield() });
    const shield = mesh(new THREE.BoxGeometry(0.62, 0.09, 0.7),
        [MAT.silver, MAT.silver, shieldTop, MAT.silver, MAT.silver, MAT.silver], 0, 0.125, -0.2);
    group.add(shield);

    // Две гребёнки по 15 выводов вдоль длинных сторон
    for (const side of [-1, 1]) {
        const header = pinHeader(15, 0.12);
        header.rotation.y = Math.PI / 2;
        header.position.set(side * 0.44, 0.05, 0);
        group.add(header);
    }

    // Разъём micro-USB, кнопки EN и BOOT, стабилизатор и чип USB-UART
    group.add(box(0.3, 0.1, 0.24, MAT.silver, 0, 0.1, 0.92));
    group.add(box(0.22, 0.04, 0.02, MAT.blackGloss, 0, 0.1, 1.045));
    for (const x of [-0.24, 0.24]) {
        group.add(box(0.14, 0.04, 0.12, MAT.silver, x, 0.07, 0.72));
        group.add(cylinder(0.035, 0.04, MAT.black, x, 0.11, 0.72, 16));
    }
    group.add(box(0.2, 0.06, 0.14, MAT.black, 0.15, 0.08, 0.45));
    group.add(box(0.2, 0.012, 0.07, MAT.silver, 0.15, 0.056, 0.36));
    group.add(chip(0.18, 0.16, 4, -0.16, 0.05, 0.45));
    group.add(smdLed(0xff3b30, -0.3, 0.062, 0.25));
    scatterSmd(group, rng, 10, [-0.32, 0.32, 0.17, 0.3], 0.05);

    // Синий светодиод мигает, когда приходят новые показания
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 16), glowing(0x8fd3f0, 0.4));
    led.position.set(0.3, 0.07, 0.25);
    group.add(led);
    group.userData.led = led;
    return group;
}

function buildDht(rng) {
    const group = new THREE.Group();
    // Маленькая плата-переходник с разъёмом и подтягивающим резистором
    group.add(roundBox(0.72, 0.04, 0.5, 0.015, MAT.pcbBlue, 0, 0.02, 0));
    const header = pinHeader(3, 0.1);
    header.position.set(0, 0.04, 0.19);
    group.add(header);
    scatterSmd(group, rng, 3, [-0.25, 0.25, 0.06, 0.1], 0.04);

    for (let i = 0; i < 4; i += 1) {
        group.add(box(0.03, 0.12, 0.012, MAT.silver, -0.15 + i * 0.1, 0.1, -0.1));
    }

    // Корпус: решётка спереди и сзади, гладкие бока, ушко с отверстием сверху
    const grille = standard(0xffffff, 0.6, 0, { map: TEXTURES.grille() });
    group.add(mesh(new THREE.BoxGeometry(0.6, 0.78, 0.28),
        [MAT.white, MAT.white, MAT.white, MAT.white, grille, grille], 0, 0.55, -0.1));
    group.add(box(0.64, 0.04, 0.3, MAT.white, 0, 0.17, -0.1));
    group.add(roundBox(0.42, 0.2, 0.1, 0.03, MAT.white, 0, 1.02, -0.1));
    const hole = cylinder(0.055, 0.12, MAT.hole, 0, 1.04, -0.1, 20);
    hole.rotation.x = Math.PI / 2;
    group.add(hole);
    return group;
}

function buildMq(rng) {
    const group = new THREE.Group();
    group.add(roundBox(0.85, 0.04, 1.15, 0.02, MAT.pcbBlue, 0, 0.02, 0));

    // Датчик: бакелитовое основание и металлический стакан с сеткой
    group.add(cylinder(0.37, 0.07, MAT.bakelite, 0, 0.075, -0.2, 40));
    const sideMesh = TEXTURES.mesh();
    sideMesh.repeat.set(10, 2);
    group.add(mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.45, 48, 1, true),
        standard(0xffffff, 0.3, 0.9, { map: sideMesh, side: THREE.DoubleSide }), 0, 0.335, -0.2));
    const topMesh = TEXTURES.mesh();
    topMesh.repeat.set(3, 3);
    const top = mesh(new THREE.CircleGeometry(0.33, 48), standard(0xffffff, 0.35, 0.8, { map: topMesh }), 0, 0.56, -0.2);
    top.rotation.x = -Math.PI / 2;
    group.add(top);
    for (const y of [0.13, 0.56]) {
        const rim = mesh(new THREE.TorusGeometry(0.335, 0.022, 12, 48), MAT.silver, 0, y, -0.2);
        rim.rotation.x = Math.PI / 2;
        group.add(rim);
    }

    // Подстроечный резистор с латунным винтом, компаратор LM393 и светодиоды
    group.add(box(0.24, 0.2, 0.24, MAT.potBlue, -0.18, 0.14, 0.32));
    group.add(cylinder(0.07, 0.03, MAT.brass, -0.18, 0.255, 0.32, 20));
    group.add(box(0.11, 0.012, 0.022, MAT.blackGloss, -0.18, 0.272, 0.32));
    group.add(chip(0.2, 0.15, 4, 0.2, 0.04, 0.3));
    group.add(smdLed(0xff3b30, -0.33, 0.052, 0.16));
    group.add(smdLed(0x34d17b, 0.33, 0.052, 0.16));
    scatterSmd(group, rng, 5, [-0.02, 0.08, 0.2, 0.42], 0.04);

    const header = pinHeader(4, 0.1);
    header.position.set(0, 0.04, 0.5);
    group.add(header);
    return group;
}

function buildGp2y(rng) {
    const group = new THREE.Group();
    group.add(roundBox(0.9, 0.36, 0.6, 0.05, MAT.black, 0, 0.2, 0));

    // Крепёжные ушки с винтами
    for (const side of [-1, 1]) {
        group.add(roundBox(0.2, 0.05, 0.4, 0.02, MAT.black, side * 0.53, 0.045, 0));
        group.add(screw(side * 0.56, 0.07, 0, 0.045));
    }

    // Сквозное отверстие для воздуха; внутри светится ИК-светодиод
    group.add(cylinder(0.14, 0.37, MAT.hole, 0.15, 0.2, 0, 32));
    const lip = mesh(new THREE.TorusGeometry(0.14, 0.014, 10, 32), MAT.blackGloss, 0.15, 0.385, 0);
    lip.rotation.x = Math.PI / 2;
    group.add(lip);
    group.add(mesh(new THREE.SphereGeometry(0.035, 12, 12), glowing(0xff4a3a, 1.6), 0.15, 0.1, 0));
    group.add(box(0.4, 0.004, 0.32, standard(0xffffff, 0.5, 0, { map: TEXTURES.label('DUST SENSOR') }), -0.2, 0.382, 0));

    // Белый разъём JST и шесть цветных проводов к колодке на плате
    group.add(box(0.08, 0.12, 0.34, MAT.white, -0.49, 0.13, 0));
    const colors = [0x3d8bd9, 0x34a853, 0xf1f3f0, 0xf2c14e, 0x16191c, 0xe0544b];
    const landing = pinHeader(6, 0.07);
    landing.rotation.y = Math.PI / 2;
    landing.position.set(-0.8, PCB_TOP - 0.21, 0);
    group.add(landing);
    colors.forEach((color, i) => {
        const z = -0.14 + i * 0.056;
        const curve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.53, 0.13, z),
            new THREE.Vector3(-0.65, 0.2, z),
            new THREE.Vector3(-0.8, 0.22, -0.175 + i * 0.07),
            new THREE.Vector3(-0.8, 0.08, -0.175 + i * 0.07),
        ]);
        group.add(mesh(new THREE.TubeGeometry(curve, 16, 0.012, 6, false), standard(color, 0.5)));
    });

    // Конденсатор и резистор из схемы включения датчика
    group.add(cylinder(0.06, 0.16, MAT.capBlue, -0.35, 0.08, -0.48, 20));
    group.add(cylinder(0.058, 0.006, MAT.silver, -0.35, 0.163, -0.48, 20));
    const resistor = mesh(new THREE.CapsuleGeometry(0.025, 0.1, 4, 10), MAT.resistor, -0.1, 0.05, -0.48);
    resistor.rotation.z = Math.PI / 2;
    group.add(resistor);
    for (const [x, color] of [[-0.13, 0x8b4513], [-0.1, 0x16191c], [-0.07, 0xd4a640]]) {
        const band = mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.012, 12), standard(color, 0.5), x, 0.05, -0.48);
        band.rotation.z = Math.PI / 2;
        group.add(band);
    }
    scatterSmd(group, rng, 2, [-0.75, -0.55, 0.3, 0.45], 0);
    return group;
}

// Провод-«дюпон» с чёрными наконечниками на концах
function jumper(from, to, color, lift = 0.45) {
    const group = new THREE.Group();
    const up = new THREE.Vector3(0, 0.12, 0);
    const middle = from.clone().lerp(to, 0.5);
    middle.y = Math.max(from.y, to.y) + lift;
    const curve = new THREE.CatmullRomCurve3([from, from.clone().add(up), middle, to.clone().add(up), to]);
    group.add(mesh(new THREE.TubeGeometry(curve, 48, 0.018, 8, false), standard(color, 0.45)));
    for (const end of [from, to]) {
        group.add(box(0.05, 0.13, 0.05, MAT.black, end.x, end.y - 0.04, end.z));
    }
    return group;
}

function statusRing(radius) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 12, 96),
        new THREE.MeshBasicMaterial({ color: RING_COLOR, transparent: true, opacity: 0.85, toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    ring.visible = false;
    return ring;
}

// ---------- Сборка ----------
const LAYOUT = {
    esp: { build: buildEsp, position: [-1.35, 0.24, 0], ring: [0.55, 0, 0] },
    dht: { build: buildDht, position: [-0.15, 0.21, -0.6], ring: [0.55, 0, -0.1] },
    mq: { build: buildMq, position: [0.3, 0.21, 0.6], ring: [0.5, 0, -0.2] },
    gp2y: { build: buildGp2y, position: [1.25, 0.21, -0.35], ring: [0.72, 0, 0] },
};

// Возвращает группу прибора и словарь датчиков. У каждого датчика в userData лежат
// его описание (sensor) и кольцо статуса (ring), у ESP32 ещё и светодиод (led).
export function buildDevice(sensorList) {
    const rng = seededRandom(42);
    const device = new THREE.Group();
    const sensors = {};

    // Основание корпуса с прорезями вентиляции и винтами по углам
    device.add(roundBox(4.3, 0.28, 2.9, 0.1, MAT.caseBase, 0, 0, 0));
    for (let i = 0; i < 9; i += 1) {
        const x = -1.2 + i * 0.3;
        device.add(box(0.2, 0.06, 0.02, MAT.blackGloss, x, 0, 1.451));
        device.add(box(0.2, 0.06, 0.02, MAT.blackGloss, x, 0, -1.451));
    }
    device.add(box(4.0, 0.07, 2.6, standard(0xffffff, 0.65, 0, { map: TEXTURES.pcb() }), 0, 0.17, 0));
    for (const x of [-1.85, 1.85]) {
        for (const z of [-1.15, 1.15]) {
            device.add(cylinder(0.09, 0.02, MAT.solder, x, PCB_TOP + 0.005, z, 20));
            device.add(screw(x, PCB_TOP + 0.01, z));
        }
    }

    // Прозрачная крышка, светящиеся рёбра и винты крышки
    const cover = new THREE.Mesh(new RoundedBoxGeometry(4.3, 1.7, 2.9, 4, 0.12), new THREE.MeshPhysicalMaterial({
        color: 0x8fd3f0, transparent: true, opacity: 0.07, roughness: 0.05,
        clearcoat: 1, depthWrite: false, side: THREE.DoubleSide,
    }));
    cover.position.y = 0.99;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(4.3, 1.7, 2.9)),
        new THREE.LineBasicMaterial({ color: 0x8fd3f0, transparent: true, opacity: 0.28 }));
    edges.position.copy(cover.position);
    device.add(cover, edges);
    for (const x of [-1.95, 1.95]) {
        for (const z of [-1.25, 1.25]) device.add(screw(x, 1.84, z, 0.07));
    }

    for (const info of sensorList) {
        const layout = LAYOUT[info.id];
        const group = layout.build(rng);
        group.position.set(...layout.position);
        group.userData.sensor = info;
        const [radius, rx, rz] = layout.ring;
        const ring = statusRing(radius);
        ring.position.set(rx, 0.09, rz);
        group.add(ring);
        group.userData.ring = ring;
        device.add(group);
        sensors[info.id] = group;
    }

    // Провода от гребёнки ESP32 к разъёмам датчиков
    const espPin = (index) => new THREE.Vector3(-0.91, 0.47, -0.84 + index * 0.12);
    const dhtPin = (index) => new THREE.Vector3(-0.25 + index * 0.1, 0.43, -0.41);
    const mqPin = (index) => new THREE.Vector3(0.15 + index * 0.1, 0.43, 1.1);
    const gpPin = (index) => new THREE.Vector3(0.45, 0.43, -0.525 + index * 0.07);
    device.add(
        jumper(espPin(2), dhtPin(0), 0xe0544b, 0.35),
        jumper(espPin(3), dhtPin(1), 0x2b2f33, 0.3),
        jumper(espPin(4), dhtPin(2), 0xf2c14e, 0.25),
        jumper(espPin(10), mqPin(0), 0xe0544b, 0.4),
        jumper(espPin(11), mqPin(1), 0x2b2f33, 0.35),
        jumper(espPin(12), mqPin(3), 0x34a853, 0.3),
        jumper(espPin(6), gpPin(1), 0xf08a3c, 0.55),
        jumper(espPin(7), gpPin(3), 0x9b6bd8, 0.5),
    );

    // USB-кабель питания выходит через заднюю стенку
    device.add(box(0.2, 0.13, 0.34, MAT.black, -1.35, 0.34, 1.21));
    const cable = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-1.35, 0.34, 1.38),
        new THREE.Vector3(-1.35, 0.34, 1.75),
        new THREE.Vector3(-1.25, 0.05, 2.3),
        new THREE.Vector3(-0.9, -0.12, 2.9),
        new THREE.Vector3(-0.2, -0.12, 3.4),
    ]);
    device.add(mesh(new THREE.TubeGeometry(cable, 64, 0.045, 10, false), MAT.cable));
    return { device, sensors };
}
