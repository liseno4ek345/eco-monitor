// Страница о проекте: живой пример с тремя сценариями воздуха, часы, шкалы норм
// и появление блоков при прокрутке. Настоящих показаний здесь нет: они видны только после входа.
(function () {
    const METRICS = JSON.parse(document.getElementById('config').textContent).metrics;
    const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const DRIFT_MS = 3000; // как часто значения чуть меняются сами
    const AUTOPLAY_MS = 7000; // как часто сценарий переключается сам, пока человек не выбрал свой
    const SWITCH_MS = 1400; // за сколько значения переезжают к новому сценарию
    const BROADCAST_MS = 300; // 3D-модели незачем слышать о каждом кадре перехода
    const LEVEL_ORDER = { good: 0, warn: 1, danger: 2 };
    const BADGES = { good: 'Всё хорошо', warn: 'Обратите внимание', danger: 'Нужно действовать' };
    // Сценарии примера: значения, вокруг которых держатся показания
    const SCENARIOS = {
        fresh: { temperature: 21.4, humidity: 47, co2: 520, dust: 9 },
        lesson: { temperature: 23.4, humidity: 51, co2: 1040, dust: 16 },
        closed: { temperature: 26.2, humidity: 57, co2: 1680, dust: 44 },
    };
    // Насколько значение может отойти от сценария, чтобы пример выглядел живым
    const SWING = { temperature: 0.3, humidity: 1.5, co2: 40, dust: 2 };

    function formatNumber(value, decimals) {
        return value.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    function findZone(metric, value) {
        for (const [upper, level, label, advice] of METRICS[metric].zones) {
            if (upper === null || value < upper) return { level, label, advice };
        }
        return null;
    }

    function setText(element, text) {
        if (element.textContent !== text) element.textContent = text;
    }

    // ---------- Часы ----------
    function tickClock() {
        const now = new Date();
        const short = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const date = now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
        for (const el of document.querySelectorAll('[data-clock="short"]')) el.textContent = short;
        for (const el of document.querySelectorAll('[data-clock="date"]')) el.textContent = date;
    }

    // ---------- Шкала норм: цветные зоны и отметка значения ----------
    function moveMark(container, metric, value) {
        const [min, max] = METRICS[metric].scale;
        const share = Math.min(Math.max((value - min) / (max - min), 0), 1);
        container.querySelector('.mark').style.left = `${share * 100}%`;
    }

    function buildScale(container, metric, value) {
        const { scale, zones } = METRICS[metric];
        const [min, max] = scale;
        container.replaceChildren();
        let from = min;
        for (const [upper, level] of zones) {
            const to = upper === null ? max : Math.min(upper, max);
            const zone = document.createElement('span');
            zone.className = 'zone';
            zone.dataset.level = level;
            zone.style.flex = `${Math.max(to - from, 0)} 1 0`;
            container.append(zone);
            from = to;
        }
        const mark = document.createElement('span');
        mark.className = 'mark';
        container.append(mark);
        moveMark(container, metric, value);
    }

    // ---------- Живой пример ----------
    const tiles = {};
    for (const tile of document.querySelectorAll('[data-demo]')) tiles[tile.dataset.demo] = tile;
    const appCards = [...document.querySelectorAll('.app-card[data-scale-metric]')];
    const chips = [...document.querySelectorAll('[data-scenario]')];
    const order = Object.keys(SCENARIOS);
    const status = document.getElementById('demo-status');
    const verdictBox = document.getElementById('demo-verdict');
    const verdictBadge = document.getElementById('demo-verdict-badge');
    const verdictTitle = document.getElementById('demo-verdict-title');

    let scenario = order[0];
    const values = { ...SCENARIOS[scenario] }; // что сейчас на экране
    let switchFrame = null;
    let autoplay = !REDUCED_MOTION;
    let stageVisible = true;
    let lastBroadcast = 0;

    // Тот же вывод, что сервер делает для настоящих показаний: решает худший показатель
    function describe() {
        const zones = Object.keys(values).map((metric) => ({ metric, ...findZone(metric, values[metric]) }));
        const worst = zones.filter((zone) => zone.advice)
            .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level])[0];
        return {
            zones,
            level: worst ? worst.level : 'good',
            title: worst ? worst.advice : 'Воздух в норме',
            reason: worst ? `${METRICS[worst.metric].label}: ${worst.label.toLowerCase()}`
                : 'Проветривать пока не нужно',
        };
    }

    // 3D-модель слушает то же событие, что и на настоящей панели, и перекрашивает воздух
    function broadcast(verdict, force) {
        const now = performance.now();
        if (!force && now - lastBroadcast < BROADCAST_MS) return;
        lastBroadcast = now;
        const levels = {};
        for (const zone of verdict.zones) levels[zone.metric] = { level: zone.level };
        const payload = { ...values, online: true, levels, summary: { level: verdict.level },
            created_at: String(Math.round(now)) };
        window.ecoLatest = payload;
        window.dispatchEvent(new CustomEvent('eco:latest', { detail: payload }));
    }

    function renderDemo(force) {
        const verdict = describe();
        for (const zone of verdict.zones) {
            const tile = tiles[zone.metric];
            if (!tile) continue;
            tile.dataset.level = zone.level;
            setText(tile.querySelector('.v'), formatNumber(values[zone.metric], METRICS[zone.metric].decimals));
            const label = tile.querySelector('.lvl');
            if (label) setText(label, zone.label);
        }

        // Кольцо CO₂ заполняется по шкале показателя
        if (tiles.co2) {
            const [min, max] = METRICS.co2.scale;
            const share = Math.min(Math.max((values.co2 - min) / (max - min), 0.04), 1);
            tiles.co2.querySelector('.ring-bar').style.strokeDasharray = `${share * 100} 100`;
        }

        status.dataset.level = verdict.level;
        setText(status.querySelector('strong'), verdict.title);
        setText(status.querySelector('small'), verdict.reason);

        // Макет панели ниже по странице показывает то же самое
        verdictBox.dataset.level = verdict.level;
        setText(verdictBadge, BADGES[verdict.level]);
        setText(verdictTitle, verdict.title);
        for (const card of appCards) {
            const metric = card.dataset.scaleMetric;
            const { decimals, unit } = METRICS[metric];
            setText(card.querySelector('.app-value'), `${formatNumber(values[metric], decimals)} ${unit}`);
            moveMark(card.querySelector('.mini-scale'), metric, values[metric]);
        }
        broadcast(verdict, force);
    }

    function setScenario(name) {
        scenario = name;
        for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.scenario === name));
        cancelAnimationFrame(switchFrame);
        const from = { ...values };
        const to = SCENARIOS[name];
        if (REDUCED_MOTION) {
            Object.assign(values, to);
            renderDemo(true);
            return;
        }
        const start = performance.now();
        const step = (now) => {
            const progress = Math.min((now - start) / SWITCH_MS, 1);
            const eased = progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2;
            for (const metric of Object.keys(to)) {
                values[metric] = from[metric] + (to[metric] - from[metric]) * eased;
            }
            renderDemo(progress === 1);
            switchFrame = progress < 1 ? requestAnimationFrame(step) : null;
        };
        switchFrame = requestAnimationFrame(step);
    }

    // Между переключениями значения слегка гуляют вокруг сценария, как у настоящих датчиков
    function drift() {
        if (switchFrame !== null) return;
        for (const metric of Object.keys(values)) {
            const center = SCENARIOS[scenario][metric];
            const pull = (center - values[metric]) * 0.2;
            const next = values[metric] + (Math.random() - 0.5) * SWING[metric] + pull;
            values[metric] = Math.min(Math.max(next, center - SWING[metric]), center + SWING[metric]);
        }
        renderDemo(true);
    }

    for (const chip of chips) {
        chip.addEventListener('click', () => {
            autoplay = false; // человек выбрал сам: больше не переключаем за него
            setScenario(chip.dataset.scenario);
        });
    }

    for (const card of appCards) {
        const metric = card.dataset.scaleMetric;
        buildScale(card.querySelector('.mini-scale'), metric, values[metric]);
    }

    // ---------- Шкалы в карточках датчиков ----------
    for (const widget of document.querySelectorAll('.w[data-scale-metric]')) {
        buildScale(widget.querySelector('.mini-scale'), widget.dataset.scaleMetric, Number(widget.dataset.sample));
    }

    // ---------- Появление при прокрутке ----------
    const revealer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                revealer.unobserve(entry.target);
            }
        }
    }, { threshold: 0.15 });
    for (const element of document.querySelectorAll('.reveal')) revealer.observe(element);

    // Пример переключается сам, только пока его видно
    new IntersectionObserver(([entry]) => {
        stageVisible = entry.isIntersecting;
    }).observe(document.querySelector('.stage'));

    // Меню чуть плотнее, когда страница прокручена
    const nav = document.querySelector('.nav');
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40), { passive: true });

    tickClock();
    renderDemo(true);
    setInterval(tickClock, 15000);
    if (!REDUCED_MOTION) {
        setInterval(() => { if (!document.hidden) drift(); }, DRIFT_MS);
        setInterval(() => {
            if (!autoplay || !stageVisible || document.hidden) return;
            setScenario(order[(order.indexOf(scenario) + 1) % order.length]);
        }, AUTOPLAY_MS);
    }
}());
