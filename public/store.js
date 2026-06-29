/**
 * Kelontong Ciel - Store Landing Page JavaScript
 * Handles navigation, animations, FAQ accordion, and product loading
 */

(function () {
  'use strict';

  // ===== NAVBAR SCROLL EFFECT =====
  const navbar = document.getElementById('navbar');

  function handleScroll() {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true });

  // ===== MOBILE NAVIGATION TOGGLE =====
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      navToggle.classList.toggle('active');
      navLinks.classList.toggle('active');
      document.body.style.overflow = navLinks.classList.contains('active') ? 'hidden' : '';
    });

    // Close nav on link click
    navLinks.querySelectorAll('.nav-link').forEach(function (link) {
      link.addEventListener('click', function () {
        navToggle.classList.remove('active');
        navLinks.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  }

  // ===== ACTIVE NAV LINK ON SCROLL =====
  const sections = document.querySelectorAll('section[id]');
  const navLinkElements = document.querySelectorAll('.nav-link');

  function updateActiveNav() {
    var scrollPos = window.scrollY + 150;

    sections.forEach(function (section) {
      var top = section.offsetTop;
      var height = section.offsetHeight;
      var id = section.getAttribute('id');

      if (scrollPos >= top && scrollPos < top + height) {
        navLinkElements.forEach(function (link) {
          link.classList.remove('active');
          if (link.getAttribute('href') === '#' + id) {
            link.classList.add('active');
          }
        });
      }
    });
  }

  window.addEventListener('scroll', updateActiveNav, { passive: true });


  // ===== SCROLL ANIMATIONS (Intersection Observer) =====
  var fadeElements = document.querySelectorAll('.fade-in');

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px',
      }
    );

    fadeElements.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback for older browsers
    fadeElements.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // ===== FAQ ACCORDION =====
  var faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(function (item) {
    var question = item.querySelector('.faq-question');

    question.addEventListener('click', function () {
      var isActive = item.classList.contains('active');

      // Close all FAQ items
      faqItems.forEach(function (faq) {
        faq.classList.remove('active');
        faq.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
      });

      // Open clicked if not already active
      if (!isActive) {
        item.classList.add('active');
        question.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // ===== CATEGORY FILTER =====
  var categoryFilter = document.getElementById('categoryFilter');

  if (categoryFilter) {
    var filterBtns = categoryFilter.querySelectorAll('.filter-btn');

    filterBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        filterBtns.forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');

        var category = btn.getAttribute('data-category');
        filterProducts(category);
      });
    });
  }

  function filterProducts(category) {
    var grid = document.getElementById('productsGrid');
    var emptyState = document.getElementById('emptyState');

    if (!grid) return;

    var cards = grid.querySelectorAll('.product-card');
    var visibleCount = 0;

    cards.forEach(function (card) {
      var cardCategory = card.getAttribute('data-category');
      if (category === 'all' || cardCategory === category) {
        card.style.display = '';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });

    if (emptyState) {
      emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
    }
  }


  // ===== PRODUCT LOADING FROM API =====
  var loadingState = document.getElementById('loadingState');
  var productsGrid = document.getElementById('productsGrid');

  function createProductCard(product) {
    var card = document.createElement('div');
    card.className = 'product-card';
    card.setAttribute('data-category', (product.category || 'digital').toLowerCase());

    var price = 'Rp ' + (product.price || 0).toLocaleString('id-ID');

    card.innerHTML =
      '<div class="product-card-inner">' +
      '<div class="product-icon">' +
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' +
      '</svg>' +
      '</div>' +
      '<h4 class="product-name">' + product.name + '</h4>' +
      '<p class="product-price">' + price + '</p>' +
      '<button class="btn btn-primary btn-sm product-order-btn" onclick="orderProduct(\'' + encodeURIComponent(product.name) + '\', ' + product.price + ', \'' + product.id + '\')">Order</button>' +
      '</div>';

    return card;
  }

  function loadProducts() {
    if (!productsGrid || !loadingState) return;

    fetch('/api/store/products')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        loadingState.style.display = 'none';

        if (data.success && data.products && data.products.length > 0) {
          data.products.forEach(function (product) {
            productsGrid.appendChild(createProductCard(product));
          });

          // Update category filters based on actual product categories
          var categories = new Set();
          data.products.forEach(function (p) {
            if (p.category) categories.add(p.category.toLowerCase());
          });

          if (categoryFilter && categories.size > 0) {
            categoryFilter.innerHTML = '<button class="filter-btn active" data-category="all">Semua</button>';
            categories.forEach(function (cat) {
              var btn = document.createElement('button');
              btn.className = 'filter-btn';
              btn.setAttribute('data-category', cat);
              btn.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
              categoryFilter.appendChild(btn);
            });

            // Re-bind filter events
            categoryFilter.querySelectorAll('.filter-btn').forEach(function (btn) {
              btn.addEventListener('click', function () {
                categoryFilter.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                filterProducts(btn.getAttribute('data-category'));
              });
            });
          }
        } else {
          var emptyState = document.getElementById('emptyState');
          if (emptyState) emptyState.style.display = 'block';
        }
      })
      .catch(function () {
        loadingState.innerHTML = '<p style="color: var(--text-secondary);">Gagal memuat produk. Silakan refresh.</p>';
      });
  }

  loadProducts();

  // ===== ORDER PRODUCT — Show Checkout Modal =====
  window.orderProduct = function (encodedName, price, productId) {
    var name = decodeURIComponent(encodedName);
    openCheckoutModal(name, price, productId);
  };

  // ===== CHECKOUT MODAL =====
  function openCheckoutModal(productName, price, productId) {
    // Remove existing modal if any
    var existing = document.getElementById('checkoutModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'checkoutModal';
    modal.className = 'checkout-overlay';
    modal.innerHTML = 
      '<div class="checkout-modal">' +
        '<button class="checkout-close" onclick="closeCheckout()">&times;</button>' +
        '<div class="checkout-header">' +
          '<h2>Checkout</h2>' +
          '<p class="checkout-product-name">' + productName + '</p>' +
          '<p class="checkout-price">Rp ' + price.toLocaleString('id-ID') + '</p>' +
        '</div>' +
        '<div class="checkout-body">' +
          '<div class="checkout-field">' +
            '<label>Jumlah</label>' +
            '<div class="qty-control">' +
              '<button type="button" onclick="changeQty(-1)">-</button>' +
              '<input type="number" id="checkoutQty" value="1" min="1" max="10" readonly>' +
              '<button type="button" onclick="changeQty(1)">+</button>' +
            '</div>' +
            '<p class="checkout-total">Total: <strong id="checkoutTotal">Rp ' + price.toLocaleString('id-ID') + '</strong></p>' +
          '</div>' +
          '<div class="checkout-field">' +
            '<label>Nomor WhatsApp (untuk kirim akun)</label>' +
            '<input type="tel" id="checkoutWA" placeholder="0838xxxxxxx" class="checkout-input">' +
          '</div>' +
          '<div class="checkout-methods">' +
            '<h3>Pilih Metode:</h3>' +
            '<button class="checkout-btn checkout-btn-qris" onclick="payWithQRIS(\'' + productId + '\', \'' + encodeURIComponent(productName) + '\', ' + price + ')">' +
              '<span class="checkout-btn-icon">📱</span>' +
              '<span class="checkout-btn-text"><strong>Bayar QRIS</strong><small>GoPay, OVO, DANA, dll</small></span>' +
            '</button>' +
            '<button class="checkout-btn checkout-btn-wa" onclick="payWithWA(\'' + encodeURIComponent(productName) + '\', ' + price + ')">' +
              '<span class="checkout-btn-icon">💬</span>' +
              '<span class="checkout-btn-text"><strong>Order via WhatsApp Bot</strong><small>Chat otomatis 24/7</small></span>' +
            '</button>' +
            '<button class="checkout-btn checkout-btn-tg" onclick="payWithTG(\'' + encodeURIComponent(productName) + '\', ' + price + ')">' +
              '<span class="checkout-btn-icon">✈️</span>' +
              '<span class="checkout-btn-text"><strong>Order via Telegram Bot</strong><small>@kelontongciel_bot</small></span>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
    // Store price for qty calculation
    modal.dataset.unitPrice = price;
  }

  window.closeCheckout = function () {
    var modal = document.getElementById('checkoutModal');
    if (modal) { modal.remove(); document.body.style.overflow = ''; }
  };

  window.changeQty = function (delta) {
    var input = document.getElementById('checkoutQty');
    var modal = document.getElementById('checkoutModal');
    var unitPrice = parseInt(modal.dataset.unitPrice) || 0;
    var val = Math.max(1, Math.min(10, parseInt(input.value) + delta));
    input.value = val;
    document.getElementById('checkoutTotal').textContent = 'Rp ' + (unitPrice * val).toLocaleString('id-ID');
  };

  window.payWithWA = function (encodedName, price) {
    var name = decodeURIComponent(encodedName);
    var qty = parseInt(document.getElementById('checkoutQty').value) || 1;
    var total = price * qty;
    var msg = 'Halo Kelontong Ciel! Saya mau order:\n\n' +
      '📦 Produk: ' + name + '\n' +
      '🔢 Qty: ' + qty + '\n' +
      '💰 Total: Rp ' + total.toLocaleString('id-ID') + '\n\n' +
      'Mohon diproses ya!';
    window.open('https://wa.me/6283852212648?text=' + encodeURIComponent(msg), '_blank');
    closeCheckout();
  };

  window.payWithTG = function (encodedName, price) {
    window.open('https://t.me/kelontongciel_bot', '_blank');
    closeCheckout();
  };

  window.payWithQRIS = function (productId, encodedName, unitPrice) {
    var qty = parseInt(document.getElementById('checkoutQty').value) || 1;
    var wa = document.getElementById('checkoutWA').value.trim();
    if (!wa || wa.length < 10) {
      alert('Masukkan nomor WhatsApp yang valid untuk menerima akun!');
      document.getElementById('checkoutWA').focus();
      return;
    }

    // Show loading
    var modal = document.getElementById('checkoutModal');
    modal.querySelector('.checkout-body').innerHTML = 
      '<div style="text-align:center; padding: 40px;">' +
        '<div class="spinner"></div>' +
        '<p style="margin-top:16px; color:var(--text-secondary);">Generating QRIS...</p>' +
      '</div>';

    // Call API
    fetch('/api/web/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: productId, quantity: qty, customerWA: wa })
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.success) {
        modal.querySelector('.checkout-body').innerHTML = 
          '<div style="text-align:center; padding: 40px;">' +
            '<p style="color:#ef4444; font-size:1.1rem;">❌ ' + (data.error || 'Gagal membuat order') + '</p>' +
            '<button class="checkout-btn checkout-btn-qris" onclick="closeCheckout()" style="margin-top:20px; max-width:200px; margin-left:auto; margin-right:auto;">Tutup</button>' +
          '</div>';
        return;
      }
      showQRISPayment(data.order);
    })
    .catch(function (err) {
      modal.querySelector('.checkout-body').innerHTML = 
        '<div style="text-align:center; padding: 40px;">' +
          '<p style="color:#ef4444;">❌ Koneksi error. Coba lagi.</p>' +
        '</div>';
    });
  };

  function showQRISPayment(order) {
    var modal = document.getElementById('checkoutModal');
    var expiresIn = Math.max(0, Math.floor((order.expiresAt - Date.now()) / 1000));

    modal.querySelector('.checkout-header h2').textContent = 'Scan QRIS';
    modal.querySelector('.checkout-body').innerHTML = 
      '<div class="qris-payment">' +
        '<div class="qris-image-wrap">' +
          '<img src="' + order.imageQr + '" alt="QRIS" class="qris-img">' +
        '</div>' +
        '<div class="qris-info">' +
          '<p class="qris-amount">Rp ' + order.payAmount.toLocaleString('id-ID') + '</p>' +
          '<p class="qris-note">Bayar tepat nominal di atas (termasuk kode unik)</p>' +
          '<div class="qris-timer" id="qrisTimer">' +
            '<span class="timer-icon">⏳</span>' +
            '<span id="qrisCountdown">' + formatTime(expiresIn) + '</span>' +
          '</div>' +
          '<div class="qris-status" id="qrisStatus">' +
            '<div class="spinner" style="width:24px;height:24px;border-width:2px;"></div>' +
            '<span>Menunggu pembayaran...</span>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Start countdown
    var countdownEl = document.getElementById('qrisCountdown');
    var countdownInterval = setInterval(function () {
      expiresIn--;
      if (expiresIn <= 0) {
        clearInterval(countdownInterval);
        document.getElementById('qrisStatus').innerHTML = '<span style="color:#ef4444;">⏰ Pembayaran expired. Silakan order ulang.</span>';
      }
      countdownEl.textContent = formatTime(expiresIn);
    }, 1000);

    // Start polling payment status
    var pollInterval = setInterval(function () {
      fetch('/api/web/order/' + order.id + '/status')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.status === 'PAID') {
            clearInterval(pollInterval);
            clearInterval(countdownInterval);
            showSuccess(order.id, data);
          } else if (data.status === 'EXPIRED') {
            clearInterval(pollInterval);
            clearInterval(countdownInterval);
            document.getElementById('qrisStatus').innerHTML = '<span style="color:#ef4444;">⏰ Pembayaran expired.</span>';
          }
        }).catch(function () {});
    }, 5000);

    // Store intervals for cleanup
    modal.dataset.pollInterval = pollInterval;
    modal.dataset.countdownInterval = countdownInterval;
  }

  function showSuccess(orderId, data) {
    var modal = document.getElementById('checkoutModal');
    var deliveryHtml = '';

    if (data.deliveryData) {
      if (data.deliveryData.type === 'account' && data.deliveryData.accounts) {
        deliveryHtml = '<div class="success-accounts">';
        data.deliveryData.accounts.forEach(function (acc, i) {
          var parts = (typeof acc === 'string') ? acc.split('|') : [];
          if (parts.length >= 2) {
            deliveryHtml += '<div class="account-item">' +
              '<p><strong>📧 Email:</strong> ' + parts[0] + '</p>' +
              '<p><strong>🔑 Password:</strong> ' + parts[1] + '</p>' +
              (parts[2] ? '<p><strong>👤 Profile:</strong> ' + parts[2] + '</p>' : '') +
              (parts[3] ? '<p><strong>🔢 PIN:</strong> ' + parts[3] + '</p>' : '') +
              '</div>';
          } else if (typeof acc === 'string') {
            deliveryHtml += '<div class="account-item"><p>' + acc + '</p></div>';
          }
        });
        deliveryHtml += '</div>';
      } else if (data.deliveryData.type === 'koalastore') {
        deliveryHtml = '<div class="success-accounts"><div class="account-item"><p>✅ Order berhasil diproses! Cek WhatsApp kamu untuk detail akun.</p></div></div>';
      } else if (data.deliveryData.type === 'manual') {
        deliveryHtml = '<div class="success-accounts"><div class="account-item"><p>⏳ Produk akan dikirim oleh admin ke WhatsApp kamu.</p></div></div>';
      }
    }

    modal.querySelector('.checkout-header h2').textContent = '✅ Pembayaran Berhasil!';
    modal.querySelector('.checkout-header').querySelector('.checkout-price').textContent = '';
    modal.querySelector('.checkout-body').innerHTML = 
      '<div class="success-page">' +
        '<div class="success-icon">🎉</div>' +
        '<p class="success-msg">Terima kasih! Pembayaran berhasil dikonfirmasi.</p>' +
        deliveryHtml +
        '<div class="success-wa-note">' +
          '<p>📱 Invoice & detail akun juga sudah dikirim ke WhatsApp kamu.</p>' +
        '</div>' +
        '<button class="checkout-btn checkout-btn-qris" onclick="closeCheckout()" style="max-width: 200px; margin: 20px auto 0;">Selesai</button>' +
      '</div>';
  }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ===== SMOOTH SCROLL FOR ANCHOR LINKS =====
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var href = this.getAttribute('href');
      if (href === '#') return;

      var target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
})();
