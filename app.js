const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const money = (amount) => `PKR ${Number(amount).toLocaleString('en-PK')}`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const categories = ['All', 'Burgers', 'Sides', 'Drinks'];
const statusOptions = ['All', 'Pending', 'Preparing', 'Out for Delivery', 'Delivered'];

function toast(message) {
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  toastRegion.append(element);
  window.setTimeout(() => element.remove(), 2800);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || 'Request failed. Please try again.');
  return data;
}

function iconFor(category, name) {
  if (category === 'Drinks') {
    return `<svg viewBox="0 0 180 150" fill="none" aria-hidden="true">
      <path d="M56 34h70l-9 96H65l-9-96Z" fill="#f3f5e8" stroke="#446a53" stroke-width="4" stroke-linejoin="round"/>
      <path d="m67 72 5 54h40l5-54H67Z" fill="#9cc7a4"/>
      <path d="m79 34 35-25M102 32l13 22" stroke="#d84b35" stroke-width="6" stroke-linecap="round"/>
      <path d="M62 61h57" stroke="#446a53" stroke-width="3"/>
      <path d="M80 86c8-7 16 7 24 0" stroke="#f8fff0" stroke-width="4" stroke-linecap="round"/>
    </svg>`;
  }
  if (category === 'Sides' && /wings/i.test(name)) {
    return `<svg viewBox="0 0 180 150" fill="none" aria-hidden="true">
      <path d="M38 85c7-23 23-37 44-37 13 0 20 9 18 21 17-17 39-12 44 2 7 19-17 37-34 46-22 13-60 12-72-6-5-7-4-17 0-26Z" fill="#d97839" stroke="#8f4b27" stroke-width="4" stroke-linejoin="round"/>
      <path d="M55 74c11-9 21-7 28-1M98 65c10-9 23-5 27 3M65 98c9 6 18 5 26-1M106 96c7 3 14 1 21-4" stroke="#f7cd73" stroke-width="5" stroke-linecap="round"/>
      <path d="M47 48c4-5 9-5 14-1M128 43c5-4 10-3 13 2" stroke="#557a54" stroke-width="4" stroke-linecap="round"/>
    </svg>`;
  }
  if (category === 'Sides') {
    return `<svg viewBox="0 0 180 150" fill="none" aria-hidden="true">
      <path d="m43 70 17-36 13 31 16-43 11 44 18-34 10 46-13 39H59L43 70Z" fill="#e1a34b" stroke="#a26728" stroke-width="4" stroke-linejoin="round"/>
      <path d="M43 69c22 9 47 12 86 0l-7 25c-22 9-52 8-72 0L43 69Z" fill="#f0c56a" stroke="#a26728" stroke-width="4" stroke-linejoin="round"/>
      <path d="m58 111 53 1" stroke="#f7d98d" stroke-width="4" stroke-linecap="round"/>
      <path d="M55 56 70 62m18-22 7 20m20-16-3 21" stroke="#f8d77e" stroke-width="4" stroke-linecap="round"/>
    </svg>`;
  }
  const double = /Double/i.test(name);
  return `<svg viewBox="0 0 200 155" fill="none" aria-hidden="true">
    <path d="M38 69c2-29 28-46 62-46s61 17 64 46H38Z" fill="#d99542" stroke="#9e6125" stroke-width="4"/>
    <path d="M42 67c25-9 92-10 118 0" stroke="#f2d18a" stroke-width="4" stroke-linecap="round"/>
    <g fill="#f4e3b1"><ellipse cx="70" cy="43" rx="3" ry="2"/><ellipse cx="101" cy="35" rx="3" ry="2"/><ellipse cx="130" cy="46" rx="3" ry="2"/><ellipse cx="84" cy="54" rx="3" ry="2"/></g>
    ${double ? '<path d="M42 82c28-9 90-9 116 0v13c-28 9-89 9-116 0V82Z" fill="#553126"/><path d="m43 86 16-6 14 7 18-7 14 7 21-7 20 7 13-5v12c-29 8-87 8-116 0V86Z" fill="#f4ce53"/>' : ''}
    <path d="M42 75c27 11 89 11 116 0l-8 14c-22 10-78 10-100 0l-8-14Z" fill="#47754a"/>
    <path d="M42 81c27 10 89 10 116 0v15c-27 12-89 12-116 0V81Z" fill="#e7bc45" stroke="#9e6125" stroke-width="3"/>
    <path d="M40 95c30 7 90 8 120-1l-9 14c-24 13-76 13-101 0L40 95Z" fill="#a7412e"/>
    <path d="M36 108c33-9 94-9 128 0 0 22-29 34-64 34s-64-12-64-34Z" fill="#d99542" stroke="#9e6125" stroke-width="4"/>
    <path d="M48 113c25 7 80 7 104 0" stroke="#f2d18a" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}

const savedCart = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem('byteburger-cart') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, quantity]) =>
      /^\d+$/.test(id) && Number.isInteger(quantity) && quantity > 0 && quantity <= 50
    ));
  } catch { return {}; }
})();
const state = {
  menu: [],
  menuLoading: true,
  menuError: '',
  category: 'All',
  search: '',
  cart: savedCart,
  cartOpen: false,
  checkout: { customer_name: '', phone: '', address: '' },
  checkoutError: '',
  submitting: false,
  confirmation: null,
  orders: [],
  ordersLoading: true,
  ordersError: '',
  orderStatus: 'All',
  adminKey: sessionStorage.getItem('byteburger-admin-key') || '',
  updatingOrder: ''
};

function saveCart() {
  localStorage.setItem('byteburger-cart', JSON.stringify(state.cart));
}

function cartRows() {
  return Object.entries(state.cart)
    .map(([id, quantity]) => ({ item: state.menu.find((item) => String(item.id) === String(id)), quantity }))
    .filter((entry) => entry.item && entry.quantity > 0);
}

function itemCount() {
  return cartRows().reduce((sum, row) => sum + row.quantity, 0);
}

function totals(rows = cartRows()) {
  const subtotal = rows.reduce((sum, row) => sum + row.item.price * row.quantity, 0);
  const delivery = subtotal === 0 || subtotal >= 2500 ? 0 : 200;
  return { subtotal, delivery, total: subtotal + delivery };
}

async function loadMenu() {
  state.menuLoading = true;
  state.menuError = '';
  if (!location.pathname.startsWith('/kitchen')) renderStore();
  try {
    state.menu = await request('/api/menu');
    state.menuLoading = false;
    for (const id of Object.keys(state.cart)) {
      if (!state.menu.some((item) => String(item.id) === String(id))) delete state.cart[id];
    }
    saveCart();
  } catch (error) {
    state.menuLoading = false;
    state.menuError = error.message;
  }
  if (!location.pathname.startsWith('/kitchen')) renderStore();
}

function header(isKitchen = false) {
  return `<header class="topbar"><div class="shell topbar-inner">
    <a class="brand" href="/" aria-label="ByteBurger home"><span class="brand-mark">bb</span>byteburger</a>
    <nav class="nav-links" aria-label="Main navigation">
      <a href="${isKitchen ? '/#menu' : '#menu'}">The menu</a>
      <a href="${isKitchen ? '/#find-us' : '#find-us'}">Find us</a>
      <a href="${isKitchen ? '/#menu' : '#menu'}">Fresh, always</a>
    </nav>
    <div class="header-actions">${isKitchen
      ? '<a class="button button-secondary" href="/">← Back to shop</a>'
      : `<a class="button button-secondary" href="/kitchen">Kitchen <span aria-hidden="true">↗</span></a>
         <button class="button button-dark cart-button" type="button" data-action="open-cart">Bag <span class="cart-count">${itemCount()}</span></button>`
    }</div>
  </div></header>`;
}

function menuCard(item) {
  const available = item.is_available;
  return `<article class="menu-card">
    <div class="food-image ${escapeHTML(item.category.toLowerCase())}">${iconFor(item.category, item.name)}</div>
    <div class="card-body">
      <div class="card-meta"><span class="category-tag">${escapeHTML(item.category)}</span>
        <span class="availability ${available ? '' : 'sold-out'}">${available ? 'Available' : 'Sold out'}</span>
      </div>
      <h3>${escapeHTML(item.name)}</h3>
      <div class="card-bottom"><span class="price">${money(item.price)}</span>
        <button class="add-button" type="button" aria-label="Add ${escapeHTML(item.name)} to cart" data-action="add" data-id="${item.id}" ${available ? '' : 'disabled'}>+</button>
      </div>
    </div>
  </article>`;
}

function filteredMenu() {
  const needle = state.search.trim().toLowerCase();
  return state.menu.filter((item) =>
    (state.category === 'All' || item.category === state.category) &&
    (!needle || item.name.toLowerCase().includes(needle))
  );
}

function cartSummary(rows, isConfirmation = false) {
  const price = totals(rows);
  return `<div class="summary">
    <div class="summary-row"><span>Subtotal</span><strong>${money(price.subtotal)}</strong></div>
    <div class="summary-row"><span>Delivery</span><strong>${price.delivery ? money(price.delivery) : 'Free'}</strong></div>
    ${price.subtotal > 0 && price.subtotal < 2500 ? '<p class="fine-print" style="text-align:left;margin-top:8px">Delivery is on us on orders over PKR 2,500.</p>' : ''}
    <div class="summary-row total"><span>Total${isConfirmation ? ' paid' : ''}</span><strong>${money(price.total)}</strong></div>
  </div>`;
}

function cartDrawer() {
  if (!state.cartOpen) return '';
  if (state.confirmation) {
    const order = state.confirmation;
    const confirmationRows = order.items.map((item) => ({ item: { name: item.name, price: item.price }, quantity: item.quantity }));
    return `<div class="overlay" data-action="overlay-close"><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title">
      <div class="drawer-head"><h2 id="cart-title">Order placed</h2><button class="close-button" data-action="close-cart" aria-label="Close">×</button></div>
      <div class="confirmation"><div class="confirm-mark">✓</div><h3>On its way to the kitchen.</h3>
        <p>Thanks, ${escapeHTML(order.customer_name)}. We’ll call you at ${escapeHTML(order.phone)} if we need anything.<br>
        Your order number is <span class="order-number">#${escapeHTML(order.id)}</span><br>
        Status: <span class="order-number">Pending</span></p>
        ${cartSummary(confirmationRows, true)}
        <button class="button button-primary" style="width:100%;margin-top:20px" data-action="finish-order">Back to the menu</button>
      </div></aside></div>`;
  }
  const rows = cartRows();
  return `<div class="overlay" data-action="overlay-close"><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title">
    <div class="drawer-head"><h2 id="cart-title">Your bag <span style="color:var(--muted);font:500 14px 'DM Sans',sans-serif">(${itemCount()})</span></h2><button class="close-button" data-action="close-cart" aria-label="Close">×</button></div>
    ${rows.length ? `<div class="cart-lines">${rows.map(({ item, quantity }) => `<div class="cart-line">
      <div><h3>${escapeHTML(item.name)}</h3><p>${money(item.price)} each</p>
        <div class="quantity-control"><button data-action="quantity" data-id="${item.id}" data-change="-1" aria-label="Decrease quantity">−</button><span>${quantity}</span><button data-action="quantity" data-id="${item.id}" data-change="1" aria-label="Increase quantity">+</button></div>
      </div><div class="line-end"><span>${money(item.price * quantity)}</span><button class="remove-link" data-action="remove" data-id="${item.id}">Remove</button></div>
    </div>`).join('')}</div>
    ${cartSummary(rows)}
    <form class="checkout" id="checkout-form">
      <h3>Delivery details</h3>
      <div class="field"><label for="customer-name">Your name</label><input id="customer-name" name="customer_name" maxlength="100" autocomplete="name" required value="${escapeHTML(state.checkout.customer_name)}" placeholder="How should we address you?"></div>
      <div class="field"><label for="customer-phone">Phone number</label><input id="customer-phone" name="phone" maxlength="40" type="tel" autocomplete="tel" required value="${escapeHTML(state.checkout.phone)}" placeholder="03xx xxxxxxx"></div>
      <div class="field"><label for="customer-address">Delivery address</label><textarea id="customer-address" name="address" maxlength="500" autocomplete="street-address" required placeholder="House, street and area">${escapeHTML(state.checkout.address)}</textarea></div>
      ${state.checkoutError ? `<p class="form-error" role="alert">${escapeHTML(state.checkoutError)}</p>` : ''}
      <button class="button button-primary" type="submit" style="width:100%" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Placing your order…' : `Place order · ${money(totals(rows).total)}`}</button>
      <p class="fine-print">Cash on delivery. Your details are only used to get this order to you.</p>
    </form>` : `<div class="empty-state" style="margin-top:24px"><strong>Your bag is taking a breather.</strong><p>Add something good from the menu.</p></div><button class="button button-primary" style="width:100%;margin-top:16px" data-action="close-cart">Find your favourites</button>`}
  </aside></div>`;
}

function renderStore() {
  document.title = 'ByteBurger — Good things between buns';
  const filtered = filteredMenu();
  app.innerHTML = `${header()}
    <main>
      <section class="shell hero">
        <div><span class="eyebrow">Ayesha Manzil, Karachi</span>
          <h1>Good things<br>between <span>buns.</span></h1>
          <p class="hero-copy">Big flavour, no fuss. Smash burgers, loaded sides and cold drinks — made fresh and delivered from our corner of Ayesha Manzil.</p>
          <div class="hero-cta"><a class="button button-primary" href="#menu">Order something good <span aria-hidden="true">↗</span></a><a class="text-link" href="#find-us">Come say hello</a></div>
          <div class="hero-note"><span class="open-dot"></span> Open today · Made fresh to order</div>
        </div>
        <div class="hero-art" aria-label="Illustration of a ByteBurger double cheeseburger">
          <svg class="food-doodle" viewBox="0 0 200 155" fill="none" aria-hidden="true">
            <path d="M38 69c2-29 28-46 62-46s61 17 64 46H38Z" fill="#d99542" stroke="#9e6125" stroke-width="4"/>
            <path d="M42 67c25-9 92-10 118 0" stroke="#f2d18a" stroke-width="4" stroke-linecap="round"/>
            <g fill="#f4e3b1"><ellipse cx="70" cy="43" rx="3" ry="2"/><ellipse cx="101" cy="35" rx="3" ry="2"/><ellipse cx="130" cy="46" rx="3" ry="2"/><ellipse cx="84" cy="54" rx="3" ry="2"/></g>
            <path d="M42 82c28-9 90-9 116 0v13c-28 9-89 9-116 0V82Z" fill="#553126"/>
            <path d="m43 86 16-6 14 7 18-7 14 7 21-7 20 7 13-5v12c-29 8-87 8-116 0V86Z" fill="#f4ce53"/>
            <path d="M42 75c27 11 89 11 116 0l-8 14c-22 10-78 10-100 0l-8-14Z" fill="#47754a"/>
            <path d="M42 81c27 10 89 10 116 0v15c-27 12-89 12-116 0V81Z" fill="#e7bc45" stroke="#9e6125" stroke-width="3"/>
            <path d="M40 95c30 7 90 8 120-1l-9 14c-24 13-76 13-101 0L40 95Z" fill="#a7412e"/>
            <path d="M36 108c33-9 94-9 128 0 0 22-29 34-64 34s-64-12-64-34Z" fill="#d99542" stroke="#9e6125" stroke-width="4"/>
            <path d="M48 113c25 7 80 7 104 0" stroke="#f2d18a" stroke-width="4" stroke-linecap="round"/>
          </svg>
          <div class="art-label">The Double Smash<small>Two patties. Zero regrets.</small></div>
        </div>
      </section>
      <section class="menu-section" id="menu"><div class="shell">
        <div class="section-heading"><div><span class="eyebrow">Good food, no guesswork</span><h2>Find your new regular.</h2><p>Cooked when you order. Gone before you know it.</p></div></div>
        <div class="menu-tools"><div class="filters" aria-label="Menu categories">${categories.map((category) => `<button class="filter-chip ${state.category === category ? 'active' : ''}" data-action="category" data-category="${category}" aria-pressed="${state.category === category}">${category}</button>`).join('')}</div>
          <label class="search-box"><span aria-hidden="true">⌕</span><input id="menu-search" type="search" value="${escapeHTML(state.search)}" placeholder="Find something tasty…" aria-label="Search menu"></label>
        </div>
        <div class="menu-grid" aria-live="polite">${state.menuLoading
          ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
          : state.menuError
            ? `<div class="error-panel">Couldn’t load the menu: ${escapeHTML(state.menuError)}<br><button class="button button-secondary" data-action="retry-menu">Try again</button></div>`
            : filtered.length ? filtered.map(menuCard).join('')
              : '<div class="empty-state"><strong>Nothing on this part of the menu.</strong><p>Try another category or search for something else.</p></div>'}
        </div>
      </div></section>
      <section class="shell location-strip" id="find-us"><div><strong><span class="location-pin" aria-hidden="true">⌖</span>Your neighbourhood burger spot.</strong><span>Ayesha Manzil, Plot A-255 · Karachi, Pakistan</span></div><a class="button button-secondary" href="https://maps.google.com/?q=Ayesha+Manzil+Karachi" target="_blank" rel="noreferrer">Get directions ↗</a></section>
    </main>
    <footer class="site-footer"><div class="shell footer-inner"><span class="footer-brand">byteburger · Made for the hungry.</span><span>Fresh food, right around the corner · Ayesha Manzil, Karachi</span></div></footer>
    ${cartDrawer()}`;
  bindStore();
}

function bindStore() {
  app.querySelectorAll('[data-action="add"]').forEach((button) => button.addEventListener('click', () => {
    const item = state.menu.find((entry) => String(entry.id) === button.dataset.id);
    if (!item || !item.is_available) return;
    state.cart[item.id] = (state.cart[item.id] || 0) + 1;
    saveCart();
    toast(`${item.name} added to your bag`);
    renderStore();
  }));
  app.querySelectorAll('[data-action="category"]').forEach((button) => button.addEventListener('click', () => {
    state.category = button.dataset.category;
    renderStore();
  }));
  app.querySelectorAll('[data-action="open-cart"]').forEach((button) => button.addEventListener('click', () => {
    state.cartOpen = true;
    renderStore();
  }));
  app.querySelectorAll('[data-action="close-cart"]').forEach((button) => button.addEventListener('click', closeCart));
  app.querySelector('[data-action="overlay-close"]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCart();
  });
  app.querySelectorAll('[data-action="quantity"]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.id;
    state.cart[id] = Math.min(50, (state.cart[id] || 0) + Number(button.dataset.change));
    if (state.cart[id] <= 0) delete state.cart[id];
    saveCart();
    renderStore();
  }));
  app.querySelectorAll('[data-action="remove"]').forEach((button) => button.addEventListener('click', () => {
    delete state.cart[button.dataset.id];
    saveCart();
    renderStore();
  }));
  app.querySelectorAll('[data-action="finish-order"]').forEach((button) => button.addEventListener('click', () => {
    state.confirmation = null;
    state.cartOpen = false;
    renderStore();
  }));
  app.querySelector('[data-action="retry-menu"]')?.addEventListener('click', loadMenu);
  app.querySelector('#menu-search')?.addEventListener('input', (event) => {
    state.search = event.target.value;
    const cursor = event.target.selectionStart;
    renderStore();
    const input = app.querySelector('#menu-search');
    input.focus();
    input.setSelectionRange(cursor, cursor);
  });
  app.querySelectorAll('#checkout-form input, #checkout-form textarea').forEach((field) => field.addEventListener('input', () => {
    state.checkout[field.name] = field.value;
  }));
  app.querySelector('#checkout-form')?.addEventListener('submit', submitOrder);
}

function closeCart() {
  state.cartOpen = false;
  state.checkoutError = '';
  renderStore();
}

async function submitOrder(event) {
  event.preventDefault();
  state.checkoutError = '';
  const form = event.currentTarget;
  const formData = new FormData(form);
  state.checkout = Object.fromEntries(['customer_name', 'phone', 'address'].map((key) => [key, String(formData.get(key) || '').trim()]));
  if (!form.reportValidity()) return;
  const rows = cartRows();
  if (!rows.length) {
    state.checkoutError = 'Add at least one item before placing an order.';
    renderStore();
    return;
  }
  state.submitting = true;
  renderStore();
  try {
    const order = await request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.checkout,
        items: rows.map(({ item, quantity }) => ({ id: item.id, quantity }))
      })
    });
    state.cart = {};
    state.checkout = { customer_name: '', phone: '', address: '' };
    saveCart();
    state.confirmation = order;
    toast('Your order is in the kitchen.');
  } catch (error) {
    state.checkoutError = error.message;
  } finally {
    state.submitting = false;
    renderStore();
  }
}

function formattedDate(value) {
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function orderCard(order) {
  const nextStatus = {
    Pending: 'Preparing',
    Preparing: 'Out for Delivery',
    'Out for Delivery': 'Delivered'
  }[order.status];
  const badgeClass = order.status.toLowerCase().replaceAll(' ', '-');
  return `<article class="order-card">
    <div class="order-top"><div><div class="order-id">Order #${escapeHTML(order.id)}</div><div class="order-time">${escapeHTML(formattedDate(order.created_at))}</div></div><span class="status-badge ${badgeClass}">${escapeHTML(order.status)}</span></div>
    <div class="order-details"><div class="customer-info"><strong>${escapeHTML(order.customer_name)}</strong><span>${escapeHTML(order.phone)}</span><address>${escapeHTML(order.address)}</address></div>
      <div class="order-items">${order.items.map((item) => `<div class="order-item"><span>${item.quantity} × ${escapeHTML(item.name)}</span><span>${money(item.subtotal)}</span></div>`).join('')}</div>
    </div>
    <div class="order-bottom"><div class="order-total">${money(order.total)}<small>Includes ${order.delivery_fee ? money(order.delivery_fee) + ' delivery' : 'free delivery'}</small></div>
      <div class="order-actions">${nextStatus ? `<button class="button button-primary" data-action="advance-order" data-id="${escapeHTML(order.id)}" data-status="${nextStatus}" ${state.updatingOrder === order.id ? 'disabled' : ''}>${state.updatingOrder === order.id ? 'Updating…' : `Mark ${nextStatus} →`}</button>` : ''}
      ${!['Delivered', 'Cancelled'].includes(order.status) ? `<button class="button button-secondary" data-action="cancel-order" data-id="${escapeHTML(order.id)}" ${state.updatingOrder === order.id ? 'disabled' : ''}>Cancel</button>` : ''}</div>
    </div>
  </article>`;
}

function renderKitchen() {
  document.title = 'Kitchen orders — ByteBurger';
  const orders = state.orders.filter((order) => state.orderStatus === 'All' || order.status === state.orderStatus);
  app.innerHTML = `<div class="kitchen-page">${header(true)}<main class="shell kitchen-main">
    <div class="kitchen-heading"><div><span class="eyebrow">Behind the counter</span><h1>Kitchen board</h1><p>Keep good food moving. Orders refresh automatically every 15 seconds.</p></div>
      <div class="kitchen-tools"><input class="admin-key" type="password" id="admin-key" autocomplete="off" placeholder="Kitchen admin key" aria-label="Kitchen admin key" value="${escapeHTML(state.adminKey)}"><button class="button button-secondary" data-action="save-key">Save key</button></div>
    </div>
    <div class="orders-toolbar"><div class="status-filters" aria-label="Filter orders">${statusOptions.map((status) => `<button class="filter-chip ${state.orderStatus === status ? 'active' : ''}" data-action="order-filter" data-status="${status}" aria-pressed="${state.orderStatus === status}">${status}</button>`).join('')}</div>
      <button class="button button-secondary" data-action="refresh-orders" ${state.ordersLoading ? 'disabled' : ''}>↻ &nbsp;Refresh orders</button>
    </div>
    <div class="orders-grid" aria-live="polite">${state.ordersLoading && !state.orders.length
      ? '<div class="skeleton" style="height:180px"></div><div class="skeleton" style="height:180px"></div>'
      : state.ordersError
        ? `<div class="error-panel">Couldn’t load orders: ${escapeHTML(state.ordersError)}<br><button class="button button-secondary" data-action="refresh-orders">Try again</button></div>`
        : orders.length ? orders.map(orderCard).join('')
          : `<div class="empty-state"><strong>${state.orderStatus === 'All' ? 'No orders just yet.' : `No ${escapeHTML(state.orderStatus.toLowerCase())} orders.`}</strong><p>New orders will show up here as soon as they’re placed.</p></div>`}
    </div>
    <footer class="site-footer kitchen-footer"><div class="footer-inner"><span class="footer-brand">byteburger · Kitchen</span><span>Ayesha Manzil, Plot A-255</span></div></footer>
  </main></div>`;
  bindKitchen();
}

function bindKitchen() {
  app.querySelectorAll('[data-action="order-filter"]').forEach((button) => button.addEventListener('click', () => {
    state.orderStatus = button.dataset.status;
    renderKitchen();
  }));
  app.querySelectorAll('[data-action="refresh-orders"]').forEach((button) => button.addEventListener('click', loadOrders));
  app.querySelector('[data-action="save-key"]')?.addEventListener('click', () => {
    state.adminKey = app.querySelector('#admin-key').value.trim();
    sessionStorage.setItem('byteburger-admin-key', state.adminKey);
    toast(state.adminKey ? 'Kitchen key saved for this session.' : 'Kitchen key cleared.');
    loadOrders();
  });
  app.querySelectorAll('[data-action="advance-order"], [data-action="cancel-order"]').forEach((button) => button.addEventListener('click', () => {
    const status = button.dataset.status || 'Cancelled';
    updateOrder(button.dataset.id, status);
  }));
}

async function loadOrders() {
  state.ordersLoading = true;
  state.ordersError = '';
  renderKitchen();
  try {
    state.orders = await request('/api/orders', {
      headers: { 'x-admin-key': state.adminKey }
    });
  } catch (error) {
    state.ordersError = error.message;
  } finally {
    state.ordersLoading = false;
    renderKitchen();
  }
}

async function updateOrder(id, status) {
  if (!state.adminKey) {
    toast('Add and save the kitchen admin key first.');
    app.querySelector('#admin-key')?.focus();
    return;
  }
  const previousOrder = state.orders.find((order) => order.id === id);
  state.updatingOrder = id;
  state.orders = state.orders.map((order) => order.id === id ? { ...order, status } : order);
  renderKitchen();
  try {
    const updated = await request(`/api/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': state.adminKey },
      body: JSON.stringify({ status })
    });
    state.orders = state.orders.map((order) => order.id === updated.id ? updated : order);
    toast(`Order #${updated.id} marked ${status.toLowerCase()}.`);
  } catch (error) {
    if (previousOrder) state.orders = state.orders.map((order) => order.id === id ? previousOrder : order);
    toast(error.message);
    if (error.message.includes('admin key')) {
      state.adminKey = '';
      sessionStorage.removeItem('byteburger-admin-key');
    }
  } finally {
    state.updatingOrder = '';
    renderKitchen();
  }
}

if (location.pathname.startsWith('/kitchen')) {
  renderKitchen();
  loadOrders();
  window.setInterval(() => {
    if (!document.hidden && !state.ordersLoading) loadOrders();
  }, 15000);
} else {
  renderStore();
  loadMenu();
}
