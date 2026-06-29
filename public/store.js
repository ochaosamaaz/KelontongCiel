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
      '<button class="btn btn-primary btn-sm product-order-btn" onclick="orderProduct(\'' + encodeURIComponent(product.name) + '\', ' + product.price + ')">Order</button>' +
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

  // ===== ORDER PRODUCT — Redirect to WhatsApp =====
  window.orderProduct = function (encodedName, price) {
    var name = decodeURIComponent(encodedName);
    var priceFormatted = 'Rp ' + (price || 0).toLocaleString('id-ID');
    var msg = 'Halo Kelontong Ciel! Saya mau order:\n\n' +
      '📦 Produk: ' + name + '\n' +
      '💰 Harga: ' + priceFormatted + '\n\n' +
      'Mohon diproses ya, terima kasih!';
    var waNumber = '6281809182368';
    window.open('https://wa.me/' + waNumber + '?text=' + encodeURIComponent(msg), '_blank');
  };

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
