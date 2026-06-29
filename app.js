// ============================================
// KELONTONG CIEL - Main Application
// ============================================

// State
let categories = [];
let allProducts = [];
let currentProduct = null;
let currentVariant = null;

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
async function fetchProducts(page = 1) {
  try {
    const response = await fetch(`${CONFIG.BASE_URL}/products?page=${page}`, {
      headers: {
        "X-API-Key": CONFIG.API_KEY,
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();
    if (result.data) {
      return result;
    }
    return null;
  } catch (error) {
    console.error("Fetch products error:", error);
    return null;
  }
}

async function loadProducts() {
  const loadingState = document.getElementById("loadingState");
  const emptyState = document.getElementById("emptyState");

  try {
    // Fetch all pages
    let page = 1;
    let allData = [];
    let hasMore = true;

    while (hasMore) {
      const result = await fetchProducts(page);
      if (result && result.data && result.data.length > 0) {
        allData = allData.concat(result.data);
        if (page >= result.last_page) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    if (allData.length === 0) {
      loadingState.style.display = "none";
      emptyState.classList.remove("hidden");
      return;
    }

    // Filter unavailable products if configured
    allProducts = CONFIG.SHOW_UNAVAILABLE_PRODUCTS
      ? allData
      : allData.filter((p) => p.status === "available");

    // Extract unique categories
    const categorySet = new Set();
    allData.forEach((p) => {
      if (p.category) {
        categorySet.add(p.category);
      }
    });
    categories = Array.from(categorySet);

    // Render
    renderCategoryFilters();
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
      <p style="font-size: 2rem; margin-bottom: 10px;">&#9888;&#65039;</p>
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
    const btn = document.createElement("button");
    btn.className = "filter-btn";
    btn.dataset.category = cat;
    btn.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    filterContainer.appendChild(btn);
  });

  // Add filter click handlers
  filterContainer.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterContainer
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const category = btn.dataset.category;
      if (category === "all") {
        renderProducts(allProducts);
      } else {
        const filtered = allProducts.filter(
          (p) => p.category && p.category.toLowerCase() === category.toLowerCase()
        );
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
      ${
        product.image
          ? `<img src="${product.image}" alt="${product.name}" class="product-image" onerror="this.style.display='none'">`
          : ""
      }
      <div class="product-category-tag">${product.category || "Digital"}</div>
      <h3 class="product-name">${product.name}</h3>
      <p class="product-description">${
        product.features ? product.features.join(" | ") : "Produk digital premium"
      }</p>
      <div class="product-footer">
        <span class="product-price">${formatPrice(product.min_price || product.price)}</span>
        <span class="product-badge ${
          product.status === "available" ? "badge-available" : "badge-unavailable"
        }">
          ${product.status === "available" ? "Tersedia" : "Habis"}
        </span>
      </div>
    </div>
  `
    )
    .join("");
}

function formatPrice(price) {
  if (!price) return "Hubungi Admin";
  return CONFIG.CURRENCY_SYMBOL + " " + price.toLocaleString("id-ID");
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

  // Show variant selection if product has variants
  let descContent = "";
  if (currentProduct.features && currentProduct.features.length > 0) {
    descContent += currentProduct.features.join(" | ");
  }

  // Build variants HTML
  let variantsHtml = "";
  if (currentProduct.variants && currentProduct.variants.length > 0) {
    // Default to first available variant
    const availableVariants = currentProduct.variants.filter(
      (v) => v.status === "available" && v.stock > 0
    );
    currentVariant = availableVariants.length > 0 ? availableVariants[0] : currentProduct.variants[0];
    priceEl.textContent = formatPrice(currentVariant.price);

    variantsHtml = `
      <div class="variant-section" style="margin-bottom: 20px;">
        <h4 style="font-size: 0.9rem; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary);">Pilih Varian:</h4>
        <div class="variant-grid" style="display: grid; gap: 8px;">
          ${currentProduct.variants
            .map(
              (v) => `
            <button class="variant-btn ${v === currentVariant ? "active" : ""}" 
                    data-code="${v.code}" 
                    ${v.status !== "available" || v.stock <= 0 ? "disabled" : ""}
                    onclick="selectVariant('${v.code}')"
                    style="
                      display: flex; justify-content: space-between; align-items: center;
                      padding: 12px 16px; border-radius: 8px; cursor: pointer;
                      border: 1px solid ${v === currentVariant ? "var(--primary)" : "var(--border)"};
                      background: ${v === currentVariant ? "rgba(108, 99, 255, 0.1)" : "var(--bg-dark)"};
                      color: ${v.status !== "available" || v.stock <= 0 ? "var(--text-muted)" : "var(--text-primary)"};
                      opacity: ${v.status !== "available" || v.stock <= 0 ? "0.5" : "1"};
                      text-align: left; font-size: 0.85rem;
                    ">
              <span>${v.name}</span>
              <span style="font-weight: 700; color: ${v.status === "available" && v.stock > 0 ? "var(--accent)" : "var(--text-muted)"};">
                ${v.status === "available" && v.stock > 0 ? formatPrice(v.price) : "Habis"}
              </span>
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;
  } else {
    currentVariant = null;
    priceEl.textContent = formatPrice(currentProduct.price);
  }

  descEl.innerHTML = (descContent ? `<p style="margin-bottom: 16px;">${descContent}</p>` : "") + variantsHtml;

  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  // Setup payment buttons
  setupPaymentButtons();
}

function selectVariant(code) {
  if (!currentProduct || !currentProduct.variants) return;
  const variant = currentProduct.variants.find((v) => v.code === code);
  if (!variant || variant.status !== "available" || variant.stock <= 0) return;

  currentVariant = variant;

  // Update price display
  document.getElementById("modalProductPrice").textContent = formatPrice(variant.price);

  // Update variant buttons visual
  const buttons = document.querySelectorAll(".variant-btn");
  buttons.forEach((btn) => {
    const isActive = btn.dataset.code === code;
    btn.style.borderColor = isActive ? "var(--primary)" : "var(--border)";
    btn.style.background = isActive ? "rgba(108, 99, 255, 0.1)" : "var(--bg-dark)";
    btn.classList.toggle("active", isActive);
  });
}

function closeOrderModal() {
  const modal = document.getElementById("orderModal");
  modal.classList.remove("active");
  document.body.style.overflow = "";
  currentProduct = null;
  currentVariant = null;
}

function getOrderDetails() {
  let productName = currentProduct.name;
  let price = currentProduct.price;

  if (currentVariant) {
    productName += ` - ${currentVariant.name}`;
    price = currentVariant.price;
  }

  return { productName, price };
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
    const { productName, price } = getOrderDetails();
    window.open(CONFIG.SAWERIA_LINK, "_blank");
    // Also open WhatsApp for confirmation
    setTimeout(() => {
      const msg = `Halo KelontongCiel! Saya sudah bayar via Saweria untuk:\n\n📦 Produk: ${productName}\n💰 Harga: ${formatPrice(price)}\n\nMohon diproses ya, terima kasih!`;
      window.open(
        `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`,
        "_blank"
      );
    }, 1000);
  };

  // WhatsApp button
  document.getElementById("payWhatsapp").onclick = () => {
    if (!currentProduct) return;
    const { productName, price } = getOrderDetails();
    const msg = `Halo KelontongCiel! Saya mau order:\n\n📦 Produk: ${productName}\n💰 Harga: ${formatPrice(price)}\n\nBagaimana cara pembayarannya?`;
    window.open(
      `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`,
      "_blank"
    );
    closeOrderModal();
  };
}

function openQrisModal() {
  if (!currentProduct) return;
  const { productName, price } = getOrderDetails();

  const qrisModal = document.getElementById("qrisModal");
  const qrisImage = document.getElementById("qrisImage");
  const qrisInstruction = document.getElementById("qrisInstruction");
  const qrisAmount = document.getElementById("qrisAmount");
  const qrisConfirmBtn = document.getElementById("qrisConfirmBtn");

  qrisImage.src = CONFIG.QRIS_IMAGE;
  qrisInstruction.textContent = CONFIG.PAYMENT_INSTRUCTION;
  qrisAmount.textContent = formatPrice(price);

  const confirmMsg = `Halo KelontongCiel! Saya sudah bayar via QRIS untuk:\n\n📦 Produk: ${productName}\n💰 Harga: ${formatPrice(price)}\n\nMohon diproses ya, terima kasih!`;
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
