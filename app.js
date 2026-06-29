// ============================================
// KELONTONG CIEL - Main Application
// ============================================

// State
let accessToken = null;
let categories = [];
let allProducts = [];
let currentProduct = null;

// ============ INITIALIZATION ============
document.addEventListener("DOMContentLoaded", () => {
  initNavbar();
  initFAQ();
  initContactLinks();
  initCounters();
  loadProducts();
});

// ============ NAVBAR ============
function initNavbar() {
  const navbar = document.getElementById("navbar");
  const navToggle = document.getElementById("navToggle");
  const navMenu = document.getElementById("navMenu");
  const navLinks = document.querySelectorAll(".nav-link");

  // Scroll effect
  window.addEventListener("scroll", () => {
    if (window.scrollY > 50) {
      navbar.classList.add("scrolled");
    } else {
      navbar.classList.remove("scrolled");
    }
  });

  // Mobile toggle
  navToggle.addEventListener("click", () => {
    navMenu.classList.toggle("active");
  });

  // Close menu on link click
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      navMenu.classList.remove("active");
      navLinks.forEach((l) => l.classList.remove("active"));
      link.classList.add("active");
    });
  });

  // Close menu on outside click
  document.addEventListener("click", (e) => {
    if (!navMenu.contains(e.target) && !navToggle.contains(e.target)) {
      navMenu.classList.remove("active");
    }
  });
}


// ============ FAQ ============
function initFAQ() {
  const faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach((item) => {
    const question = item.querySelector(".faq-question");
    question.addEventListener("click", () => {
      const isActive = item.classList.contains("active");
      faqItems.forEach((i) => i.classList.remove("active"));
      if (!isActive) {
        item.classList.add("active");
      }
    });
  });
}

// ============ CONTACT LINKS ============
function initContactLinks() {
  const waContact = document.getElementById("waContact");
  const tgContact = document.getElementById("tgContact");
  const igContact = document.getElementById("igContact");

  if (waContact) {
    waContact.href = `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(CONFIG.WHATSAPP_MESSAGE)}`;
  }
  if (tgContact && CONFIG.SOCIAL_LINKS.telegram) {
    tgContact.href = CONFIG.SOCIAL_LINKS.telegram;
  }
  if (igContact && CONFIG.SOCIAL_LINKS.instagram) {
    igContact.href = CONFIG.SOCIAL_LINKS.instagram;
  }
}

// ============ COUNTER ANIMATION ============
function initCounters() {
  const counters = document.querySelectorAll(".stat-number");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCounter(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );

  counters.forEach((counter) => observer.observe(counter));
}

function animateCounter(element) {
  const target = parseInt(element.getAttribute("data-count"));
  const duration = 2000;
  const step = target / (duration / 16);
  let current = 0;

  const timer = setInterval(() => {
    current += step;
    if (current >= target) {
      current = target;
      clearInterval(timer);
    }
    element.textContent = Math.floor(current).toLocaleString("id-ID");
  }, 16);
}


// ============ KOALASTORE API INTEGRATION ============
async function authenticate() {
  try {
    const response = await fetch(`${CONFIG.BASE_URL}/auth/anonymous`, {
      method: "POST",
      headers: {
        "App-Token": CONFIG.APP_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: generateDeviceId(),
        platform: "web",
      }),
    });

    const data = await response.json();
    if (data.success && data.data && data.data.token) {
      accessToken = data.data.token;
      return true;
    }
    console.error("Authentication failed:", data);
    return false;
  } catch (error) {
    console.error("Auth error:", error);
    return false;
  }
}

function generateDeviceId() {
  // Generate or retrieve a persistent device ID
  let deviceId = localStorage.getItem("kc_device_id");
  if (!deviceId) {
    deviceId = "kc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("kc_device_id", deviceId);
  }
  return deviceId;
}

function getHeaders() {
  return {
    "App-Token": CONFIG.APP_TOKEN,
    Authorization: accessToken ? `Bearer ${accessToken}` : "",
    "Content-Type": "application/json",
  };
}

async function fetchCategories() {
  try {
    const response = await fetch(
      `${CONFIG.BASE_URL}/places/${CONFIG.STORE_ID}/categories`,
      { headers: getHeaders() }
    );
    const data = await response.json();
    if (data.success && data.data) {
      return data.data;
    }
    return [];
  } catch (error) {
    console.error("Fetch categories error:", error);
    return [];
  }
}

async function loadProducts() {
  const loadingState = document.getElementById("loadingState");
  const emptyState = document.getElementById("emptyState");
  const productsGrid = document.getElementById("productsGrid");

  try {
    // Step 1: Authenticate
    const authSuccess = await authenticate();
    if (!authSuccess) {
      showError("Gagal terhubung ke server. Coba refresh halaman.");
      return;
    }

    // Step 2: Fetch categories with products
    categories = await fetchCategories();

    if (!categories || categories.length === 0) {
      loadingState.style.display = "none";
      emptyState.classList.remove("hidden");
      return;
    }

    // Step 3: Extract all products from categories
    allProducts = [];
    categories.forEach((category) => {
      if (category.services && category.services.length > 0) {
        category.services.forEach((service) => {
          allProducts.push({
            ...service,
            categoryName: category.name,
            categoryId: category.id,
          });
        });
      }
    });

    // Filter unavailable products if configured
    if (!CONFIG.SHOW_UNAVAILABLE_PRODUCTS) {
      allProducts = allProducts.filter((p) => p.is_available);
    }

    // Step 4: Render category filters
    renderCategoryFilters();

    // Step 5: Render products
    loadingState.style.display = "none";
    renderProducts(allProducts);

    if (allProducts.length === 0) {
      emptyState.classList.remove("hidden");
    }
  } catch (error) {
    console.error("Load products error:", error);
    showError("Terjadi kesalahan. Silakan refresh halaman.");
  }
}

function showError(message) {
  const loadingState = document.getElementById("loadingState");
  loadingState.innerHTML = `
    <div style="color: var(--text-muted);">
      <p style="font-size: 2rem; margin-bottom: 10px;">⚠️</p>
      <p>${message}</p>
      <button onclick="location.reload()" class="btn btn-outline" style="margin-top: 15px;">Refresh</button>
    </div>
  `;
}


// ============ RENDER FUNCTIONS ============
function renderCategoryFilters() {
  const filterContainer = document.getElementById("categoryFilter");
  filterContainer.innerHTML = `<button class="filter-btn active" data-category="all">Semua</button>`;

  categories.forEach((cat) => {
    if (cat.services && cat.services.length > 0) {
      const btn = document.createElement("button");
      btn.className = "filter-btn";
      btn.dataset.category = cat.id;
      btn.textContent = cat.name;
      filterContainer.appendChild(btn);
    }
  });

  // Add filter click handlers
  filterContainer.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterContainer.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const categoryId = btn.dataset.category;
      if (categoryId === "all") {
        renderProducts(allProducts);
      } else {
        const filtered = allProducts.filter((p) => p.categoryId === categoryId);
        renderProducts(filtered);
      }
    });
  });
}

function renderProducts(products) {
  const grid = document.getElementById("productsGrid");
  const emptyState = document.getElementById("emptyState");

  if (products.length === 0) {
    grid.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  grid.innerHTML = products
    .map(
      (product) => `
    <div class="product-card" onclick="openOrderModal('${product.id}')">
      ${product.photo ? `<img src="${product.photo.thumb_100 || product.photo.thumbnail}" alt="${product.name}" class="product-image" onerror="this.style.display='none'">` : ""}
      <div class="product-category-tag">${product.categoryName}</div>
      <h3 class="product-name">${product.name}</h3>
      <p class="product-description">${product.description || "Produk digital premium"}</p>
      <div class="product-footer">
        <span class="product-price">${formatPrice(product.price)}</span>
        <span class="product-badge ${product.is_available ? "badge-available" : "badge-unavailable"}">
          ${product.is_available ? "Tersedia" : "Habis"}
        </span>
      </div>
    </div>
  `
    )
    .join("");
}

function formatPrice(price) {
  if (!price) return "Hubungi Admin";
  return (
    CONFIG.CURRENCY_SYMBOL +
    " " +
    price.toLocaleString("id-ID")
  );
}


// ============ ORDER MODAL ============
function openOrderModal(productId) {
  currentProduct = allProducts.find((p) => p.id === productId);
  if (!currentProduct) return;

  const modal = document.getElementById("orderModal");
  const nameEl = document.getElementById("modalProductName");
  const priceEl = document.getElementById("modalProductPrice");
  const descEl = document.getElementById("modalProductDesc");

  nameEl.textContent = currentProduct.name;
  priceEl.textContent = formatPrice(currentProduct.price);
  descEl.textContent = currentProduct.description || "Produk digital premium berkualitas tinggi.";

  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  // Setup payment buttons
  setupPaymentButtons();
}

function closeOrderModal() {
  const modal = document.getElementById("orderModal");
  modal.classList.remove("active");
  document.body.style.overflow = "";
  currentProduct = null;
}

function setupPaymentButtons() {
  // QRIS button
  document.getElementById("payQris").onclick = () => {
    closeOrderModal();
    openQrisModal();
  };

  // Saweria button
  document.getElementById("paySaweria").onclick = () => {
    if (!currentProduct) return;
    const saweriaUrl = CONFIG.SAWERIA_LINK;
    window.open(saweriaUrl, "_blank");
    // Also open WhatsApp for confirmation
    setTimeout(() => {
      const msg = `Halo KelontongCiel! Saya sudah bayar via Saweria untuk:\n\n📦 Produk: ${currentProduct.name}\n💰 Harga: ${formatPrice(currentProduct.price)}\n\nMohon diproses ya, terima kasih!`;
      window.open(`https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, "_blank");
    }, 1000);
  };

  // WhatsApp button
  document.getElementById("payWhatsapp").onclick = () => {
    if (!currentProduct) return;
    const msg = `Halo KelontongCiel! Saya mau order:\n\n📦 Produk: ${currentProduct.name}\n💰 Harga: ${formatPrice(currentProduct.price)}\n\nBagaimana cara pembayarannya?`;
    window.open(`https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, "_blank");
    closeOrderModal();
  };
}

function openQrisModal() {
  if (!currentProduct) return;

  const qrisModal = document.getElementById("qrisModal");
  const qrisImage = document.getElementById("qrisImage");
  const qrisInstruction = document.getElementById("qrisInstruction");
  const qrisAmount = document.getElementById("qrisAmount");
  const qrisConfirmBtn = document.getElementById("qrisConfirmBtn");

  qrisImage.src = CONFIG.QRIS_IMAGE;
  qrisInstruction.textContent = CONFIG.PAYMENT_INSTRUCTION;
  qrisAmount.textContent = formatPrice(currentProduct.price);

  const confirmMsg = `Halo KelontongCiel! Saya sudah bayar via QRIS untuk:\n\n📦 Produk: ${currentProduct.name}\n💰 Harga: ${formatPrice(currentProduct.price)}\n\nMohon diproses ya, terima kasih!`;
  qrisConfirmBtn.href = `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(confirmMsg)}`;

  qrisModal.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeQrisModal() {
  const qrisModal = document.getElementById("qrisModal");
  qrisModal.classList.remove("active");
  document.body.style.overflow = "";
}

// Modal close handlers
document.getElementById("modalClose").addEventListener("click", closeOrderModal);
document.getElementById("qrisModalClose").addEventListener("click", closeQrisModal);

// Close modal on overlay click
document.getElementById("orderModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeOrderModal();
});
document.getElementById("qrisModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeQrisModal();
});

// Close modal on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeOrderModal();
    closeQrisModal();
  }
});
