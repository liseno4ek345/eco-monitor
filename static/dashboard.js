// Панель мониторинга: получает показания с сервера и рисует их на странице.
// В демо работает так же, только сервер отдаёт придуманные показания.
const config = JSON.parse(document.getElementById('config').textContent);
const METRICS = config.metrics;
const URLS = config.urls;
const IS_DEMO = config.demo;
const REFRESH_LATEST_MS = 5000;
const REFRESH_HISTORY_MS = 30000;
const RANGE_NAMES = { '1h': 'час', '24h': 'сутки', '7d': 'неделю', '30d': 'месяц' };
const RANGE_SECONDS = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_BRIDGED_STEPS = 5; // короткий пропуск соединяем линией, длинный показываем разрывом
const STEADY_SHARE = 0.02; // изменение меньше 2% шкалы считаем «без изменений»
const VISIBLE_SHARE = 0.9; // показания должны попадать в период с запасом, а не на самый край
const NOTIFY_KEY = 'eco-notify';
const METRIC_KEY = 'eco-metric';
const RANGE_KEY = 'eco-range';
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Цвет точки на значке вкладки: те же цвета, что у состояний на странице
const TAB_COLORS = {
    good: '#2fbf80', warn: '#e9a52c', danger: '#ea5a4f',
    offline: '#9a9890', unknown: '#9a9890', noserver: '#9a9890',
};

const elements = {
    verdict: document.getElementById('verdict'),
    badge: document.getElementById('verdict-badge'),
    title: document.getElementById('verdict-title'),
    advice: document.getElementById('verdict-advice'),
    detail: document.getElementById('verdict-detail'),
    setup: document.getElementById('setup'),
    dashboard: document.getElementById('dashboard'),
    readings: document.getElementById('readings'),
    chartPanel: document.getElementById('chart-panel'),
    chart: document.getElementById('chart'),
    tip: document.getElementById('chart-tip'),
    empty: document.getElementById('chart-empty'),
    emptyText: document.getElementById('chart-empty-text'),
    emptyAction: document.getElementById('chart-empty-action'),
    legend: document.getElementById('legend'),
    chartTitle: document.getElementById('chart-title'),
    chartAbout: document.getElementById('chart-about'),
    chartHint: document.getElementById('chart-hint'),
    chartIcon: document.getElementById('chart-icon'),
    download: document.getElementById('download'),
    downloadText: document.getElementById('download-text'),
    notify: document.getElementById('notify'),
    notifyText: document.getElementById('notify-text'),
};
const metricButtons = [...document.querySelectorAll('.reading')];
const periodButtons = [...document.querySelectorAll('.period')];

// ---------- Мелкие настройки в браузере ----------
// Выбранный показатель и период помнит сам браузер. В приватном окне хранилище бывает
// недоступно: тогда всё работает как обычно, просто ничего не запоминается.
function recall(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function remember(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Без хранилища настройка просто не запомнится
    }
}

function pressOnly(buttons, active) {
    for (const button of buttons) {
        button.setAttribute('aria-pressed', button === active ? 'true' : 'false');
    }
}

// Возвращаем показатель и период, которые человек выбрал в прошлый раз
const savedMetric = recall(METRIC_KEY);
if (Object.hasOwn(METRICS, savedMetric)) {
    pressOnly(metricButtons, metricButtons.find((button) => button.dataset.metric === savedMetric));
}
const savedRange = recall(RANGE_KEY);
if (Object.hasOwn(RANGE_NAMES, savedRange)) {
    pressOnly(periodButtons, periodButtons.find((button) => button.dataset.range === savedRange));
}

// Выбранный показатель берём со страницы: порядок ключей в JSON отличается от порядка на экране
const state = {
    metric: document.querySelector('.reading[aria-pressed="true"]').dataset.metric,
    range: document.querySelector('.period[aria-pressed="true"]').dataset.range,
    latest: null, // последний ответ сервера с показаниями
    history: null,
    historyRequest: 0,
    lastLevel: null,
    rangeChosen: false, // человек сам выбрал период в этот заход
    drawnKey: null, // какой график сейчас нарисован: «показатель|период»
};

const BADGES = {
    loading: 'Подключение',
    waiting: 'Ждём прибор',
    good: 'Всё хорошо',
    warn: 'Обратите внимание',
    danger: 'Нужно действовать',
    offline: 'Нет новых данных',
    unknown: 'Нет значений',
    noserver: 'Сервер недоступен',
};

function formatNumber(value, decimals) {
    return value.toLocaleString('ru-RU', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

function formatValue(metric, value) {
    const { decimals, unit } = METRICS[metric];
    return `${formatNumber(value, decimals)} ${unit}`;
}

function formatAge(seconds) {
    if (seconds < 10) return 'только что';
    if (seconds < 60) return `${seconds} сек. назад`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
    return `${Math.floor(seconds / 86400)} дн. назад`;
}

function findZone(metric, value) {
    for (const [upper, level, label] of METRICS[metric].zones) {
        if (upper === null || value < upper) return { level, label };
    }
    return null;
}

function svgElement(name, attributes, text) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
}

function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

// Запрос к серверу. Если сессия закончилась, отправляет на страницу входа.
async function getJson(url) {
    const response = await fetch(url);
    if (response.status === 401) {
        window.location.href = URLS.login;
        throw new Error('Нужно войти');
    }
    if (!response.ok) throw new Error(`Сервер ответил кодом ${response.status}`);
    return response.json();
}

// ---------- Вкладка браузера ----------
const pageTitle = document.title;
const faviconLink = document.querySelector('link[rel="icon"]');
const defaultFavicon = faviconLink ? faviconLink.href : '';
let tabLevel = null;

function faviconWithDot(color) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        + '<rect width="64" height="64" rx="16" fill="#0e0e0f"/>'
        + '<g transform="translate(11 12) scale(1.75)" fill="none" stroke="#fff" stroke-width="2"'
        + ' stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8a3 3 0 1 1-3 3"/></g>'
        + `<circle cx="48" cy="16" r="13" fill="${color}" stroke="#fff" stroke-width="4"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Состояние воздуха видно даже на соседней вкладке: по цветной точке на значке и по заголовку
function setTabStatus(level, title) {
    const color = TAB_COLORS[level];
    document.title = color ? `${IS_DEMO ? 'Демо: ' : ''}${title} — Эко-Монитор` : pageTitle;
    if (level === tabLevel || !faviconLink) return;
    tabLevel = level;
    faviconLink.href = color ? faviconWithDot(color) : defaultFavicon;
}

// ---------- Общий вывод о воздухе ----------
function renderAdvice(items) {
    const signature = JSON.stringify(items);
    if (elements.advice.dataset.signature === signature) return;
    elements.advice.dataset.signature = signature;
    elements.advice.hidden = items.length === 0;
    elements.advice.replaceChildren(...items.map((item) => {
        const row = document.createElement('li');
        row.dataset.level = item.level;
        const icon = document.createElement('span');
        icon.className = 'advice-icon';
        const svg = svgElement('svg', { class: 'icon', 'aria-hidden': 'true' });
        svg.append(svgElement('use', { href: `#i-${item.metric}` }));
        icon.append(svg);
        row.append(icon, item.text);
        return row;
    }));
}

function setVerdict(level, title, detail, advice = []) {
    elements.verdict.dataset.level = level;
    setText(elements.badge, BADGES[level]);
    setText(elements.title, title);
    setText(elements.detail, detail);
    renderAdvice(advice);
    setTabStatus(level, title);
}

// Главный совет уже стоит в заголовке, здесь остальные: по одному на показатель не в норме
function otherAdvice(data) {
    const order = { danger: 0, warn: 1 };
    const items = Object.entries(data.levels)
        .filter(([, zone]) => zone.advice)
        .map(([metric, zone]) => ({ metric, level: zone.level, text: zone.advice }))
        .sort((a, b) => order[a.level] - order[b.level]);
    const main = items.findIndex((item) => item.text === data.summary.title);
    if (main !== -1) items.splice(main, 1);
    return items;
}

// ---------- Текущие показания ----------
function buildScales() {
    for (const button of metricButtons) {
        const { scale, zones } = METRICS[button.dataset.metric];
        const [min, max] = scale;
        const bar = button.querySelector('.scale');
        let from = min;
        for (const [upper, level] of zones) {
            const to = upper === null ? max : Math.min(upper, max);
            const zone = document.createElement('span');
            zone.className = 'scale-zone';
            zone.dataset.level = level;
            zone.style.flexGrow = String(Math.max(to - from, 0));
            zone.style.flexBasis = '0';
            bar.append(zone);
            from = to;
        }
        const mark = document.createElement('span');
        mark.className = 'scale-mark';
        mark.hidden = true;
        bar.append(mark);
    }
}

const numberFrames = new WeakMap();

// Число плавно доезжает до нового значения, а не меняется скачком
function animateNumber(element, value, decimals) {
    const known = element.dataset.value !== undefined;
    const from = known ? Number(element.dataset.value) : 0;
    element.dataset.value = String(value);
    cancelAnimationFrame(numberFrames.get(element));
    if (REDUCED_MOTION || document.hidden || from === value) {
        element.textContent = formatNumber(value, decimals);
        return;
    }
    const duration = known ? 600 : 900;
    const start = performance.now();
    const step = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - (1 - progress) ** 3;
        element.textContent = formatNumber(from + (value - from) * eased, decimals);
        if (progress < 1) numberFrames.set(element, requestAnimationFrame(step));
    };
    numberFrames.set(element, requestAnimationFrame(step));
}

// Стрелка рядом со значением: растёт оно, падает или держится
function renderTrend(trendEl, metric, data) {
    const delta = data.trends ? data.trends[metric] : undefined;
    if (delta === undefined || !data.online) {
        trendEl.hidden = true;
        return;
    }
    const { decimals, unit, scale } = METRICS[metric];
    trendEl.hidden = false;
    if (Math.abs(delta) < (scale[1] - scale[0]) * STEADY_SHARE) {
        trendEl.dataset.direction = 'flat';
        trendEl.textContent = '→ без изменений за 15 мин';
        return;
    }
    const sign = delta > 0 ? '+' : '−';
    trendEl.dataset.direction = delta > 0 ? 'up' : 'down';
    trendEl.textContent = `${delta > 0 ? '↑' : '↓'} ${sign}${formatNumber(Math.abs(delta), decimals)} ${unit} за 15 мин`;
}

function renderReading(button, data) {
    const metric = button.dataset.metric;
    const value = data[metric];
    const number = button.querySelector('.number');
    const stateEl = button.querySelector('.reading-state');
    const mark = button.querySelector('.scale-mark');
    const trendEl = button.querySelector('.reading-trend');
    const { decimals, scale } = METRICS[metric];

    if (value === null || value === undefined) {
        cancelAnimationFrame(numberFrames.get(number));
        delete number.dataset.value;
        number.textContent = '–';
        stateEl.textContent = 'нет данных';
        delete stateEl.dataset.level;
        mark.hidden = true;
        trendEl.hidden = true;
        return;
    }
    renderTrend(trendEl, metric, data);

    animateNumber(number, value, decimals);
    const position = (value - scale[0]) / (scale[1] - scale[0]);
    mark.style.left = `${Math.min(Math.max(position, 0), 1) * 100}%`;
    mark.hidden = false;

    if (data.online) {
        stateEl.textContent = data.levels[metric].label;
        stateEl.dataset.level = data.levels[metric].level;
    } else {
        stateEl.textContent = 'последнее значение';
        delete stateEl.dataset.level;
    }
}

function renderLatest(data) {
    // 3D-модель перекрашивает воздух по этим же показаниям. Она грузится дольше панели,
    // поэтому последние данные ещё и сохраняем, чтобы модель взяла их при запуске
    window.ecoLatest = data;
    window.dispatchEvent(new CustomEvent('eco:latest', { detail: data }));
    const firstAnswer = state.latest === null;
    state.latest = data;
    const hasData = Object.keys(data).length > 0;
    elements.readings.classList.remove('loading');
    elements.setup.hidden = hasData;
    elements.dashboard.hidden = !hasData;

    if (!hasData) {
        setVerdict('waiting', 'Ждём первые показания',
            'Прибор ещё ничего не присылал. Как только пришлёт, данные появятся здесь сами.');
        document.getElementById('setup-url').textContent =
            `http://IP-этого-компьютера:${window.location.port || 80}/api/data`;
        return;
    }

    if (firstAnswer) fitRangeToData(data);
    elements.readings.classList.toggle('stale', !data.online);
    for (const button of metricButtons) renderReading(button, data);
    renderLegend();

    if (!data.online) {
        setVerdict('offline', 'Прибор не на связи',
            `Последние показания пришли ${formatAge(data.age_seconds)}. `
            + 'Проверьте, что прибор включён и подключён к сети.');
    } else {
        const updated = `Обновлено ${formatAge(data.age_seconds)}.`;
        setVerdict(data.summary.level, data.summary.title,
            data.summary.level === 'good' ? `Все показатели в порядке. ${updated}` : updated,
            otherAdvice(data));
        notifyIfWorse(data.summary);
    }
}

// ---------- Напоминания о проветривании ----------
// Уведомления браузер разрешает только на защищённых адресах, например http://127.0.0.1
const canNotify = !IS_DEMO && 'Notification' in window && window.isSecureContext;

function notifyEnabled() {
    try {
        return canNotify && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
    } catch {
        return false;
    }
}

function renderNotifyButton() {
    if (!canNotify) return;
    const on = notifyEnabled();
    elements.notify.hidden = false;
    elements.notify.setAttribute('aria-pressed', String(on));
    elements.notifyText.textContent = on ? 'Напоминания включены' : 'Напоминать о проветривании';
}

async function toggleNotify() {
    let on = !notifyEnabled();
    if (on && Notification.permission !== 'granted') {
        on = (await Notification.requestPermission()) === 'granted';
    }
    remember(NOTIFY_KEY, on ? '1' : '0');
    renderNotifyButton();
}

// Сообщаем, только когда воздух стал хуже, чтобы не повторять одно и то же каждые 5 секунд
function notifyIfWorse(summary) {
    const previous = state.lastLevel;
    state.lastLevel = summary.level;
    if (summary.level !== 'danger' || previous === 'danger' || previous === null) return;
    if (!notifyEnabled()) return;
    new Notification('Эко-Монитор', { body: summary.title, tag: 'eco-air' });
}

async function refreshLatest() {
    try {
        renderLatest(await getJson(URLS.latest));
    } catch (error) {
        console.error(error);
        elements.readings.classList.remove('loading');
        elements.readings.classList.add('stale');
        for (const stateEl of elements.readings.querySelectorAll('.reading-state')) {
            if (stateEl.dataset.level) stateEl.textContent = 'последнее значение';
            delete stateEl.dataset.level;
        }
        setVerdict('noserver', 'Нет связи с сервером',
            'Страница показывает старые значения. Проверьте, что сайт запущен и сеть работает.');
    }
}

// ---------- График ----------
// Круглый шаг делений шкалы: 1, 2, 5, 10, 20, 50...
function niceStep(span, count) {
    const raw = span / count;
    const power = 10 ** Math.floor(Math.log10(raw));
    const scaled = raw / power;
    const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return nice * power;
}

function yDomain(metric, values) {
    const [scaleMin, scaleMax] = METRICS[metric].scale;
    const minSpan = (scaleMax - scaleMin) * 0.1; // чтобы мелкий шум не выглядел как резкие скачки
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (high - low < minSpan) {
        const middle = (high + low) / 2;
        low = middle - minSpan / 2;
        high = middle + minSpan / 2;
    }
    const step = niceStep(high - low, 4);
    return { low: Math.floor(low / step) * step, high: Math.ceil(high / step) * step, step };
}

function normBand(metric) {
    let from = -Infinity;
    for (const [upper, level] of METRICS[metric].zones) {
        const to = upper === null ? Infinity : upper;
        if (level === 'good') return [from, to];
        from = to;
    }
    return null;
}

function timeLabel(text, range) {
    const [date, time] = text.split(' ');
    const [, month, day] = date.split('-');
    const clock = time.slice(0, 5);
    return range === '7d' || range === '30d' ? `${day}.${month}` : clock;
}

function fullTimeLabel(text) {
    const [date, time] = text.split(' ');
    const [, month, day] = date.split('-');
    return `${day}.${month}, ${time.slice(0, 5)}`;
}

// Самый короткий период, в который с запасом попадают последние показания прибора
function rangeWithData(ageSeconds) {
    return Object.keys(RANGE_SECONDS)
        .find((key) => ageSeconds < RANGE_SECONDS[key] * VISIBLE_SHARE) || null;
}

function setRange(range, { save }) {
    pressOnly(periodButtons, periodButtons.find((button) => button.dataset.range === range));
    state.range = range;
    if (save) remember(RANGE_KEY, range);
    refreshHistory();
}

// Если прибор давно молчит, сразу открываем период, где его показания ещё видны:
// иначе человек увидит пустой график и решит, что данных нет совсем
function fitRangeToData(data) {
    if (data.online || state.rangeChosen) return;
    const fitting = rangeWithData(data.age_seconds);
    if (fitting && RANGE_SECONDS[fitting] > RANGE_SECONDS[state.range]) {
        setRange(fitting, { save: false });
    }
}

// Вместо пустого графика объясняем, почему он пуст, и предлагаем период, где данные есть
function showEmptyChart(range) {
    state.drawnKey = null;
    const latest = state.latest || {};
    const value = latest[state.metric];
    let text = `За ${RANGE_NAMES[range]} измерений нет`;
    let suggestion = null;
    if (latest.age_seconds !== undefined && (value === null || value === undefined)) {
        text = 'Этот датчик пока не присылал значений';
    } else if (latest.age_seconds !== undefined) {
        suggestion = rangeWithData(latest.age_seconds);
        if (!suggestion) text = 'Прибор не присылал данные больше месяца';
        else if (RANGE_SECONDS[suggestion] <= RANGE_SECONDS[range]) suggestion = null;
    }
    elements.emptyText.textContent = text;
    elements.emptyAction.hidden = !suggestion;
    if (suggestion) {
        elements.emptyAction.dataset.range = suggestion;
        elements.emptyAction.textContent = `Показать за ${RANGE_NAMES[suggestion]}`;
    }
    elements.empty.hidden = false;
}

function drawChart() {
    const old = elements.chart.querySelector('svg');
    if (old) old.remove();
    elements.tip.hidden = true;
    elements.empty.hidden = true;
    if (!state.history) return;

    const width = elements.chart.clientWidth;
    const height = elements.chart.clientHeight;
    if (!width) return;

    const { metric } = state;
    const { points, range } = state.history;
    const values = points.map((point) => point[metric]).filter((value) => value !== null);
    if (values.length === 0) {
        showEmptyChart(range);
        return;
    }

    // Линия прорисовывается, только когда на экране новый график, а не при каждом обновлении
    const key = `${metric}|${range}`;
    const animate = !REDUCED_MOTION && key !== state.drawnKey;
    state.drawnKey = key;

    const margin = { top: 24, right: 14, bottom: 26, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const baseline = margin.top + plotHeight;
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img',
        'aria-label': `График: ${METRICS[metric].label}, период ${RANGE_NAMES[range]}` });
    elements.chart.prepend(svg);

    const gradient = svgElement('linearGradient', { id: 'chart-area', x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svgElement('stop', { offset: 0, class: 'area-top' }),
        svgElement('stop', { offset: 1, class: 'area-bottom' }));
    const defs = svgElement('defs', {});
    defs.append(gradient);
    svg.append(defs);

    const domain = yDomain(metric, values);
    const x = (index) => margin.left + (points.length > 1 ? index / (points.length - 1) : 0.5) * plotWidth;
    const y = (value) => margin.top + (1 - (value - domain.low) / (domain.high - domain.low)) * plotHeight;

    // Полоса нормы
    const band = normBand(metric);
    if (band) {
        const top = Math.min(band[1], domain.high);
        const bottom = Math.max(band[0], domain.low);
        if (top > bottom) {
            svg.append(svgElement('rect', { class: 'norm', x: margin.left, width: plotWidth,
                y: y(top), height: y(bottom) - y(top) }));
        }
    }

    // Горизонтальные деления и единица измерения над ними
    svg.append(svgElement('text', { class: 'unit', x: margin.left - 8, y: 11, 'text-anchor': 'end' },
        METRICS[metric].unit));
    for (let tick = domain.low; tick <= domain.high + domain.step / 2; tick += domain.step) {
        svg.append(svgElement('line', { class: 'grid', x1: margin.left, x2: width - margin.right,
            y1: y(tick), y2: y(tick) }));
        const decimals = domain.step < 1 ? 1 : 0;
        svg.append(svgElement('text', { x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end' },
            formatNumber(tick, decimals)));
    }

    // Подписи времени
    const labelCount = width < 480 ? 3 : 6;
    for (let i = 0; i < labelCount; i += 1) {
        const index = Math.round((i / (labelCount - 1)) * (points.length - 1));
        const anchor = i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle';
        svg.append(svgElement('text', { x: x(index), y: height - 6, 'text-anchor': anchor },
            timeLabel(points[index].created_at, range)));
    }

    // Линия и заливка под ней: там, где данных нет, остаётся разрыв
    const filled = points.flatMap((point, index) => (point[metric] === null ? [] : [index]));
    let line = '';
    let area = '';
    let segmentStart = null;
    const closeArea = (lastIndex) => {
        if (segmentStart !== null && lastIndex !== segmentStart) {
            area += `L${x(lastIndex).toFixed(1)} ${baseline} L${x(segmentStart).toFixed(1)} ${baseline} Z `;
        }
    };
    filled.forEach((index, order) => {
        const value = points[index][metric];
        const joinsPrevious = order > 0 && index - filled[order - 1] <= MAX_BRIDGED_STEPS;
        const joinsNext = order < filled.length - 1 && filled[order + 1] - index <= MAX_BRIDGED_STEPS;
        if (!joinsPrevious && !joinsNext) {
            svg.append(svgElement('circle', { class: 'dot', cx: x(index), cy: y(value), r: 3 }));
        }
        const point = `${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
        if (!joinsPrevious) {
            closeArea(filled[order - 1]);
            segmentStart = index;
        }
        area += `${joinsPrevious ? 'L' : 'M'}${point}`;
        line += `${joinsPrevious ? 'L' : 'M'}${point}`;
    });
    closeArea(filled[filled.length - 1]);
    const areaPath = svgElement('path', { class: 'area', d: area });
    const linePath = svgElement('path', { class: 'line', d: line });
    svg.append(areaPath, linePath);

    // Пульсирующая точка «сейчас», если последние показания свежие
    const lastIndex = filled[filled.length - 1];
    if (lastIndex >= points.length - 2) {
        const now = { cx: x(lastIndex), cy: y(points[lastIndex][metric]) };
        svg.append(svgElement('circle', { class: 'now-ring', ...now, r: 6 }),
            svgElement('circle', { class: 'now-dot', ...now, r: 4.5 }));
    }

    if (animate) {
        const length = linePath.getTotalLength();
        linePath.style.strokeDasharray = String(length);
        linePath.style.strokeDashoffset = String(length);
        areaPath.style.opacity = '0';
        // Два кадра: браузер должен сначала нарисовать начальное состояние
        requestAnimationFrame(() => requestAnimationFrame(() => {
            linePath.style.transition = 'stroke-dashoffset 0.9s ease-out';
            linePath.style.strokeDashoffset = '0';
            areaPath.style.transition = 'opacity 0.8s ease-out 0.25s';
            areaPath.style.opacity = '1';
        }));
        linePath.addEventListener('transitionend', () => {
            linePath.style.strokeDasharray = '';
        }, { once: true });
    }

    // Подсказка при наведении
    const cursor = svgElement('line', { class: 'cursor', y1: margin.top, y2: baseline, visibility: 'hidden' });
    const marker = svgElement('circle', { class: 'dot', r: 5, visibility: 'hidden' });
    svg.append(cursor, marker);

    svg.addEventListener('pointermove', (event) => {
        const box = svg.getBoundingClientRect();
        const ratio = (event.clientX - box.left - margin.left) / plotWidth;
        const nearest = Math.round(ratio * (points.length - 1));
        const index = Math.min(Math.max(nearest, 0), points.length - 1);
        const value = points[index][metric];
        if (value === null) {
            hideCursor();
            return;
        }
        for (const [name, val] of [['x1', x(index)], ['x2', x(index)]]) cursor.setAttribute(name, val);
        cursor.setAttribute('visibility', 'visible');
        marker.setAttribute('cx', x(index));
        marker.setAttribute('cy', y(value));
        marker.setAttribute('visibility', 'visible');

        const zone = findZone(metric, value);
        const strong = document.createElement('strong');
        strong.textContent = formatValue(metric, value);
        const label = document.createElement('span');
        label.className = 'tip-zone';
        label.dataset.level = zone.level;
        label.textContent = zone.label;
        const time = document.createElement('span');
        time.textContent = fullTimeLabel(points[index].created_at);
        elements.tip.replaceChildren(strong, label, time);
        elements.tip.hidden = false;
        const tipWidth = elements.tip.offsetWidth;
        const left = Math.min(Math.max(x(index) - tipWidth / 2, 0), width - tipWidth);
        elements.tip.style.left = `${left}px`;
    });

    function hideCursor() {
        cursor.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        elements.tip.hidden = true;
    }
    svg.addEventListener('pointerleave', hideCursor);
}

// Расшифровка под графиком: какие значения считаются нормой, а какие нет
function renderLegend() {
    const { zones, unit } = METRICS[state.metric];
    const latest = state.latest || {};
    const value = latest.online ? latest[state.metric] : null;
    const current = value === null || value === undefined
        ? -1 : zones.findIndex(([upper]) => upper === null || value < upper);
    const signature = `${state.metric}|${current}`;
    if (elements.legend.dataset.signature === signature) return;
    elements.legend.dataset.signature = signature;

    let low = null;
    elements.legend.replaceChildren(...zones.map(([upper, level, label], index) => {
        const item = document.createElement('li');
        item.dataset.level = level;
        const name = document.createElement('strong');
        name.textContent = label;
        const range = document.createElement('small');
        if (low === null) range.textContent = `до ${formatNumber(upper, 0)} ${unit}`;
        else if (upper === null) range.textContent = `от ${formatNumber(low, 0)} ${unit}`;
        else range.textContent = `${formatNumber(low, 0)}–${formatNumber(upper, 0)} ${unit}`;
        item.append(name, range);
        if (index === current) {
            item.classList.add('current');
            item.title = 'Сейчас значение в этой зоне';
        }
        low = upper;
        return item;
    }));
}

function renderStats() {
    const stats = state.history ? state.history.stats[state.metric] : null;
    for (const cell of document.querySelectorAll('[data-stat]')) {
        cell.textContent = stats ? formatValue(state.metric, stats[cell.dataset.stat]) : '–';
    }
}

function renderChartSection() {
    const meta = METRICS[state.metric];
    elements.chartTitle.textContent = meta.label;
    elements.chartAbout.textContent = meta.about;
    elements.chartHint.textContent = meta.unit_hint;
    elements.chartHint.hidden = !meta.unit_hint;
    elements.chartIcon.setAttribute('href', `#i-${state.metric}`);
    elements.download.href = `${URLS.export}?range=${state.range}`;
    elements.downloadText.textContent = `Скачать таблицу за ${RANGE_NAMES[state.range]}`;
    renderLegend();
    drawChart();
    renderStats();
}

async function refreshHistory() {
    // Ответ на старый запрос не должен затереть график после смены периода
    state.historyRequest += 1;
    const request = state.historyRequest;
    try {
        const data = await getJson(`${URLS.history}?range=${state.range}`);
        if (request !== state.historyRequest) return;
        state.history = data;
        renderChartSection();
    } catch (error) {
        console.error('Не удалось загрузить историю:', error);
    }
}

// ---------- Переключатели ----------
// График должен оказаться на экране целиком, но карточки при этом лучше не прятать
function revealChart() {
    const box = elements.chartPanel.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    elements.chartPanel.scrollIntoView({
        behavior: REDUCED_MOTION ? 'auto' : 'smooth',
        block: box.height > window.innerHeight - 100 ? 'start' : 'end',
    });
}

function selectMetric(metric) {
    pressOnly(metricButtons, metricButtons.find((button) => button.dataset.metric === metric));
    state.metric = metric;
    remember(METRIC_KEY, metric);
    renderChartSection();
    window.dispatchEvent(new CustomEvent('eco:metric', { detail: { metric } }));
    revealChart();
}

for (const button of metricButtons) {
    button.addEventListener('click', () => selectMetric(button.dataset.metric));
}

// Нажали на датчик в 3D-модели: показываем его график
window.addEventListener('eco:select-metric', (event) => {
    if (Object.hasOwn(METRICS, event.detail.metric)) selectMetric(event.detail.metric);
});

// Карточки чуть наклоняются вслед за курсором
const fancyPointer = window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches;
if (fancyPointer) {
    for (const button of metricButtons) {
        button.addEventListener('pointermove', (event) => {
            const box = button.getBoundingClientRect();
            const px = (event.clientX - box.left) / box.width;
            const py = (event.clientY - box.top) / box.height;
            button.style.setProperty('--rx', `${(0.5 - py) * 8}deg`);
            button.style.setProperty('--ry', `${(px - 0.5) * 10}deg`);
        });
        button.addEventListener('pointerleave', () => {
            button.style.setProperty('--rx', '0deg');
            button.style.setProperty('--ry', '0deg');
        });
    }
}

for (const button of periodButtons) {
    button.addEventListener('click', () => {
        state.rangeChosen = true;
        setRange(button.dataset.range, { save: true });
    });
}

elements.emptyAction.addEventListener('click', () => {
    state.rangeChosen = true;
    setRange(elements.emptyAction.dataset.range, { save: true });
});

elements.notify.addEventListener('click', toggleNotify);
renderNotifyButton();

new ResizeObserver(drawChart).observe(elements.chart);

// Вернулись на вкладку: сразу показываем свежие данные, не дожидаясь таймера
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshLatest();
        refreshHistory();
    }
});

buildScales();
renderChartSection();
window.dispatchEvent(new CustomEvent('eco:metric', { detail: { metric: state.metric } }));
refreshLatest();
refreshHistory();
setInterval(() => { if (!document.hidden) refreshLatest(); }, REFRESH_LATEST_MS);
setInterval(() => { if (!document.hidden) refreshHistory(); }, REFRESH_HISTORY_MS);
