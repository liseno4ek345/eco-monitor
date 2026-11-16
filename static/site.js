// Общее для всех страниц: шапка, сообщения, показ пароля.
(function () {
    const navbar = document.getElementById('navbar');
    function updateNavbar() {
        navbar.classList.toggle('scrolled', window.scrollY > 20);
    }
    window.addEventListener('scroll', updateNavbar, { passive: true });
    updateNavbar();

    const flashes = document.getElementById('flashes');
    if (flashes) setTimeout(() => flashes.remove(), 6000);

    for (const button of document.querySelectorAll('[data-toggle-password]')) {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.togglePassword);
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            button.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
            button.classList.toggle('active', show);
        });
    }
}());
