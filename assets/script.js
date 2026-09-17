const PRODUCTS_COLLECTION = "products";
const PRICE_UPDATES_COLLECTION = "price_updates_list";
const CATEGORIES_DOCUMENT = "app_settings/productCategories";
const FIRESTORE_REST_ROOT = "https://firestore.googleapis.com/v1/projects/supermarket-b0553/databases/(default)/documents";
const PRODUCT_CACHE_KEY = "show-products-first-page-v1";
const PRODUCT_CACHE_TTL = 15 * 60 * 1000;
const MAX_PRODUCT_CACHE_BYTES = 512 * 1024;
const pageLoadStartedAt = performance.now();
const productGrid = document.getElementById("product-grid");
const searchInput = document.getElementById("search");
const modal = document.getElementById("productModal");
const categoriesContainer = document.getElementById("categories");
const modalImage = document.getElementById("modal-image");
const modalName = document.getElementById("modal-name");
const modalBadge = document.getElementById("modal-subtitle");
const modalPrice = document.getElementById("modal-price");
const modalBarcode = document.getElementById("modal-barcode");
const modalCategory = document.getElementById("modal-category");
const modalUpdatedAt = document.getElementById("modal-updated-at");
const closeModal = document.querySelector(".close-modal");
const backToTop = document.getElementById("backToTop");
const darkModeToggle = document.getElementById("darkModeToggle");
const loadMoreProductsButton = document.getElementById("load-more-products");

let allProducts = [];
let latestPriceUpdates = new Map();
let activeProductResults = [];
let visibleProductCount = 48;
let categoryOrder = [];
const PRODUCT_IMAGE_FALLBACK = "https://placehold.co/320x240/eef2f4/64748b?text=No+Image";
const FIREBASE_STORAGE_BUCKET = "supermarket-b0553.firebasestorage.app";
const firebaseConfig = {
    apiKey: "AIzaSyDOXucjJQHpWHH1Gc6BKdFkRgFGNsIoxoo",
    projectId: "supermarket-b0553",
    storageBucket: FIREBASE_STORAGE_BUCKET,
    messagingSenderId: "905002063423",
    appId: "1:905002063423:web:e7ab2a26c9cffecb1b4a8a"
};
const loadState = {
    initialRendered: false,
    fallbackStarted: false,
    backgroundSyncStarted: false,
    firstProductsSnapshotSkipped: false,
    cacheRendered: false
};

function performanceLog(label, startedAt = pageLoadStartedAt) {
    console.info(`[products-performance] ${label}: ${(performance.now() - startedAt).toFixed(1)}ms`);
}

function readProductCache() {
    try {
        const raw = localStorage.getItem(PRODUCT_CACHE_KEY) || "";
        if (raw.length > MAX_PRODUCT_CACHE_BYTES) {
            localStorage.removeItem(PRODUCT_CACHE_KEY);
            return null;
        }
        const cached = JSON.parse(raw || "null");
        if (!cached || Date.now() - Number(cached.savedAt) > PRODUCT_CACHE_TTL || !Array.isArray(cached.products)) return null;
        return cached.products;
    } catch (error) {
        localStorage.removeItem(PRODUCT_CACHE_KEY);
        return null;
    }
}

function saveProductCache(products) {
    const cacheProducts = products.slice(0, 48).map(product => {
        const image = [product.imageHd, product.imageOriginal, product.image]
            .map(value => String(value || "").trim())
            .find(value => value && !value.startsWith("data:image/") && value.length < 2000) || "";
        return {
            id: product.id,
            name: product.name,
            productName: product.productName,
            price: product.price,
            category: product.category,
            image
        };
    });
    const save = () => {
        try {
            localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), products: cacheProducts }));
        } catch (error) {
            console.warn("تعذر حفظ ذاكرة المنتجات:", error);
        }
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(save, { timeout: 1500 });
    else setTimeout(save, 0);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function productName(product) {
    return String(product.name || product.productName || "بدون اسم").trim();
}

function productImage(product) {
    const source = String(product.imageHd || product.imageOriginal || product.image || "").trim();
    return normalizeProductImageSource(source);
}

function getUpdateTime(update) {
    const value = update?.timestamp || update?.updateId;
    if (value?.toMillis instanceof Function) return value.toMillis();
    if (value?.seconds !== undefined) return Number(value.seconds) * 1000;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

function latestUpdate(productId) {
    return latestPriceUpdates.get(productId);
}

function priceMarkup(product, update) {
    const currentPrice = escapeHtml(product.price ?? 0);
    if (update && String(update.price) === String(product.price)) {
        return `<span class="card-old-price">${escapeHtml(update.oldPrice ?? 0)} جنيه</span><span class="card-new-price">${currentPrice} جنيه</span>`;
    }
    return `<span class="card-new-price">${currentPrice} جنيه</span>`;
}

function normalizeProductImageSource(source) {
    if (!source || source.startsWith("data:image/") || /^https?:\/\//i.test(source)) return source;
    if (source.startsWith("gs://")) {
        const separatorIndex = source.indexOf("/", 5);
        if (separatorIndex > 5) {
            const bucket = source.slice(5, separatorIndex);
            const objectPath = source.slice(separatorIndex + 1);
            return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
        }
    }
    if (source.startsWith("products/")) {
        return `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(source)}?alt=media`;
    }
    return source;
}

function dateText(value) {
    const date = value?.toDate instanceof Function
        ? value.toDate()
        : value?.seconds
            ? new Date(Number(value.seconds) * 1000)
            : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return `آخر تحديث: ${date.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" })}`;
}

function showProductModal(product) {
    const name = productName(product);
    const update = latestUpdate(product.id);
    modalImage.src = productImage(product) || PRODUCT_IMAGE_FALLBACK;
    modalImage.alt = name;
    modalName.textContent = name;
    modalName.title = name;
    modalBadge.hidden = true;
    modalPrice.innerHTML = priceMarkup(product, update).replace(/جنيه/g, "ج.م");
    modalBarcode.textContent = `الباركود: ${product.barcode || "بدون باركود"}`;
    modalCategory.textContent = `القسم: ${product.category || "غير محدد"}`;
    modalUpdatedAt.textContent = dateText(product.updatedAt || product.createdAt);
    modalUpdatedAt.hidden = !modalUpdatedAt.textContent;
    modal.classList.add("show");
}

function productCardMarkup(product) {
    const name = productName(product);
    const update = latestUpdate(product.id);
    return `<article class="product-card card" data-product-id="${escapeHtml(product.id)}">
            <div class="product-thumb card-image-box">
                <div class="product-image-box">
                    <img loading="lazy" decoding="async" alt="${escapeHtml(name)}" src="${escapeHtml(productImage(product) || PRODUCT_IMAGE_FALLBACK)}">
                </div>
            </div>
            <div class="product-info card-body">
                <h3 class="product-name">
                    <span class="product-name-main">${escapeHtml(name)}</span>
                </h3>
                <span class="product-category">${escapeHtml(String(product.category || "").trim())}</span>
                <span class="price">${priceMarkup(product, update)}</span>
            </div>
        </article>`;
}

function renderProducts(products, emptyMessage = "لا توجد منتجات متاحة حالياً") {
    const renderStartedAt = performance.now();
    performanceLog("render start");
    activeProductResults = products;
    if (!products.length) {
        productGrid.innerHTML = `<div class="no-results" style="grid-column:1/-1;text-align:center;padding:30px;color:var(--muted)">${emptyMessage}</div>`;
        if (loadMoreProductsButton) loadMoreProductsButton.hidden = true;
        performanceLog("render end", renderStartedAt);
        return;
    }

    productGrid.innerHTML = activeProductResults
        .slice(0, visibleProductCount)
        .map(productCardMarkup)
        .join("");
    if (loadMoreProductsButton) {
        loadMoreProductsButton.hidden = visibleProductCount >= activeProductResults.length;
    }
    performanceLog("render end", renderStartedAt);
}

function renderCategories() {
    const productCategories = [...new Set(allProducts.map(product => String(product.category || "").trim()).filter(Boolean))];
    const orderedCategories = [
        ...categoryOrder.filter(category => productCategories.includes(category)),
        ...productCategories.filter(category => !categoryOrder.includes(category))
    ];
    categoriesContainer.replaceChildren();
    ["الكل", ...orderedCategories].forEach((category, index) => {
        const button = document.createElement("button");
        button.className = `category${index === 0 ? " active" : ""}`;
        button.textContent = category;
        button.dataset.category = category;
        categoriesContainer.appendChild(button);
    });
}

async function loadProducts() {
    const requestStartedAt = performance.now();
    performanceLog("page load start");
    if (!window.firebase) throw new Error("FIREBASE_UNAVAILABLE");
    if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig);

    const firestore = window.firebase.firestore();
    performanceLog("products request start", requestStartedAt);
    const productsSnapshot = await firestore.collection(PRODUCTS_COLLECTION).get();
    performanceLog("products received", requestStartedAt);
    allProducts = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderCategories();
    renderProducts(allProducts);
    saveProductCache(allProducts);
    loadState.initialRendered = true;
    performanceLog("initial products rendered", requestStartedAt);
    setTimeout(() => startBackgroundSync(firestore), 0);
}

function applyLatestUpdates(updates) {
    const nextUpdates = new Map();
    updates.forEach(update => {
        const current = nextUpdates.get(update.productId);
        if (!current || getUpdateTime(update) > getUpdateTime(current)) {
            nextUpdates.set(update.productId, update);
        }
    });
    latestPriceUpdates = nextUpdates;
}

function sameProductSnapshot(snapshot) {
    if (snapshot.size !== allProducts.length) return false;
    const currentProducts = new Map(allProducts.map(product => [product.id, product]));
    return snapshot.docs.every(doc => {
        const current = currentProducts.get(doc.id);
        const next = doc.data();
        return current && ["name", "productName", "price", "category", "image", "imageHd", "imageOriginal", "updatedAt"].every(field => String(current[field] ?? "") === String(next[field] ?? ""));
    });
}

function refreshVisiblePrices() {
    productGrid.querySelectorAll("[data-product-id]").forEach(card => {
        const product = allProducts.find(item => item.id === card.dataset.productId);
        const price = card.querySelector(".price");
        if (product && price) price.innerHTML = priceMarkup(product, latestUpdate(product.id));
    });
}

function startBackgroundSync(firestore) {
    if (loadState.backgroundSyncStarted) return;
    loadState.backgroundSyncStarted = true;

    firestore.collection(PRODUCTS_COLLECTION).onSnapshot(snapshot => {
        if (!loadState.firstProductsSnapshotSkipped && sameProductSnapshot(snapshot)) {
            loadState.firstProductsSnapshotSkipped = true;
            return;
        }
        loadState.firstProductsSnapshotSkipped = true;
        allProducts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderCategories();
        renderProducts(allProducts);
    }, error => console.error("تعذر تحديث المنتجات مباشرة:", error));

    firestore.collection(PRICE_UPDATES_COLLECTION).onSnapshot(snapshot => {
        applyLatestUpdates(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        if (loadState.initialRendered) refreshVisiblePrices();
    }, error => console.error("تعذر تحديث الأسعار مباشرة:", error));

    firestore.doc(CATEGORIES_DOCUMENT).onSnapshot(snapshot => {
        if (!snapshot.exists) return;
        const categories = snapshot.data()?.categories;
        if (!Array.isArray(categories)) return;
        categoryOrder = [...new Set(categories.map(category => String(category).trim()).filter(Boolean))];
        renderCategories();
    }, error => console.error("تعذر تحديث الأقسام مباشرة:", error));
}

function parseRestValue(value) {
    if (!value || typeof value !== "object") return value;
    if ("stringValue" in value) return value.stringValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return Number(value.doubleValue);
    if ("booleanValue" in value) return value.booleanValue;
    if ("nullValue" in value) return null;
    if ("arrayValue" in value) return (value.arrayValue.values || []).map(parseRestValue);
    if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, parseRestValue(item)]));
    return value;
}

async function loadProductsFallback() {
    if (loadState.fallbackStarted || loadState.initialRendered) return;
    loadState.fallbackStarted = true;
    const response = await fetch(`${FIRESTORE_REST_ROOT}/${PRODUCTS_COLLECTION}?pageSize=1000`);
    if (!response.ok) throw new Error(`FIRESTORE_REST_${response.status}`);
    const payload = await response.json();
    allProducts = (payload.documents || []).map(document => ({
        id: String(document.name || "").split("/").pop(),
        ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, parseRestValue(value)]))
    }));
    renderCategories();
    renderProducts(allProducts);
    loadState.initialRendered = true;
}

productGrid?.addEventListener("click", event => {
    const card = event.target.closest("[data-product-id]");
    if (!card) return;
    const product = allProducts.find(item => item.id === card.dataset.productId);
    if (product) showProductModal(product);
});

categoriesContainer?.addEventListener("click", event => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    document.querySelectorAll(".category").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    const category = button.dataset.category;
    visibleProductCount = 48;
    renderProducts(category === "الكل" ? allProducts : allProducts.filter(product => product.category === category));
});

searchInput?.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    visibleProductCount = 48;
    const filteredProducts = allProducts.filter(product => [productName(product), product.category, product.price]
        .some(value => String(value ?? "").toLowerCase().includes(query)));
    renderProducts(filteredProducts, query ? "لا يوجد منتج بهذا الاسم" : "لا توجد منتجات متاحة حالياً");
});

loadMoreProductsButton?.addEventListener("click", () => {
    visibleProductCount += 48;
    renderProducts(activeProductResults);
});

closeModal?.addEventListener("click", () => modal.classList.remove("show"));
modal?.addEventListener("click", event => { if (event.target === modal) modal.classList.remove("show"); });
document.addEventListener("keydown", event => { if (event.key === "Escape") modal?.classList.remove("show"); });

window.addEventListener("scroll", () => backToTop?.classList.toggle("show", window.scrollY > 400));
backToTop?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

darkModeToggle?.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    const dark = document.body.classList.contains("dark-mode");
    localStorage.setItem("theme", dark ? "dark" : "light");
    darkModeToggle.innerHTML = `<i class="fa-solid fa-${dark ? "sun" : "moon"}"></i>`;
});

if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
    if (darkModeToggle) darkModeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
}

loadProducts().catch(async error => {
    console.error("تعذر تحميل المنتجات عبر Firebase:", error);
    try {
        await loadProductsFallback();
    } catch (fallbackError) {
        console.error("تعذر تحميل المنتجات احتياطياً:", fallbackError);
        productGrid.innerHTML = `<div class="no-results" style="grid-column:1/-1;text-align:center;padding:30px;color:var(--muted)">تعذر تحميل المنتجات حالياً</div>`;
    }
});

const cachedProducts = readProductCache();
if (cachedProducts?.length) {
    allProducts = cachedProducts;
    renderCategories();
    renderProducts(cachedProducts);
    loadState.cacheRendered = true;
    performanceLog("cached products rendered");
}
