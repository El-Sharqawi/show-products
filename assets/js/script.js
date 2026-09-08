const FIRESTORE_API_ROOT = "https://firestore.googleapis.com/v1/projects/supermarket-b0553/databases/(default)/documents";
const PRODUCTS_COLLECTION = "products";
const PRICE_UPDATES_COLLECTION = "price_updates_list";
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
const PRODUCT_IMAGE_FALLBACK = "https://placehold.co/320x240/eef2f4/64748b?text=No+Image";
const FIREBASE_STORAGE_BUCKET = "supermarket-b0553.firebasestorage.app";
const firebaseConfig = {
    apiKey: "AIzaSyDOXucjJQHpWHH1Gc6BKdFkRgFGNsIoxoo",
    projectId: "supermarket-b0553",
    storageBucket: FIREBASE_STORAGE_BUCKET,
    messagingSenderId: "905002063423",
    appId: "1:905002063423:web:e7ab2a26c9cffecb1b4a8a"
};
let categoryOrder = [];
let liveUnsubscribers = [];
let fallbackLoadPromise = null;
let hasLiveProductsSnapshot = false;
let liveSyncStarted = false;

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

function parseProductName(value) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const separatorIndex = normalized.search(/[.-]/);
    if (separatorIndex < 0) return { main: normalized, badge: "" };

    const main = normalized.slice(0, separatorIndex).trim();
    const badge = normalized.slice(separatorIndex + 1).trim();
    if (!main || !badge) return { main: normalized, badge: "" };
    return { main, badge };
}

function productParts(product) {
    return parseProductName(productName(product));
}

function getProductBrand(product) {
    const explicitBrand = [product?.brand, product?.brandName, product?.manufacturer]
        .map(value => String(value || "").trim())
        .find(Boolean);
    if (explicitBrand) return explicitBrand;

    const normalizedName = productName(product)
        .replace(/[.,;:!?()[\]{}\/\\_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return normalizedName.split(" ").slice(0, 2).join(" ");
}

function normalizeCategoryText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[إأآا]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/[ًٌٍَُِّْـ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeProductName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getProductPackaging(product) {
    const explicitPackaging = [product?.packaging, product?.packageType, product?.size, product?.quantity]
        .map(value => String(value || "").trim())
        .find(Boolean);
    if (explicitPackaging) return normalizeProductName(explicitPackaging);

    const productNameValue = normalizeProductName(productName(product));
    const packagingTerms = ["كانز", "علبه", "زجاجه", "بلاستيك", "كيس", "عبوه", "كرتونه", "can", "bottle", "plastic", "bag", "box", "carton"];
    const packagingTerm = packagingTerms.find(term => productNameValue.includes(normalizeProductName(term))) || "";
    const size = productNameValue.match(/\d+(?:[.,]\d+)?\s*(?:مل|ملي|لتر|ل|جم|جرام|كجم|kg|g|ml|l)\b/i)?.[0] || "";
    return normalizeProductName(`${packagingTerm} ${size}`);
}

function compareProductsByCategoryAndBrand(a, b, categoryOrder) {
    const categoryCompare = getProductCategoryOrder(a, categoryOrder) - getProductCategoryOrder(b, categoryOrder);
    if (categoryCompare !== 0) return categoryCompare;

    const brandCompare = getProductBrand(a).localeCompare(getProductBrand(b), "ar", { sensitivity: "base" });
    if (brandCompare !== 0) return brandCompare;

    const packagingCompare = getProductPackaging(a).localeCompare(getProductPackaging(b), "ar", { sensitivity: "base", numeric: true });
    if (packagingCompare !== 0) return packagingCompare;

    const nameCompare = normalizeProductName(productName(a)).localeCompare(normalizeProductName(productName(b)), "ar", { sensitivity: "base", numeric: true });
    if (nameCompare !== 0) return nameCompare;

    return getProductCreationTime(a) - getProductCreationTime(b);
}

function getProductCategoryOrder(product, categoryOrder) {
    const category = normalizeCategoryText(product?.category);
    const primaryCategories = ["مشروبات", "عصائر", "شيبسي", "مقرمشات"];
    const primaryIndex = primaryCategories.findIndex(item => normalizeCategoryText(item) === category);
    if (primaryIndex >= 0) return primaryIndex;

    const savedCategoryIndex = [...categoryOrder.keys()].findIndex(item => normalizeCategoryText(item) === category);
    return primaryCategories.length + (savedCategoryIndex >= 0 ? savedCategoryIndex : categoryOrder.size);
}

function getProductCreationTime(product) {
    const value = product?.createdAt;
    if (value?.toMillis instanceof Function) return value.toMillis();
    if (value?.seconds !== undefined) return Number(value.seconds) * 1000;
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
    const parsedValue = Date.parse(String(value || ""));
    return Number.isFinite(parsedValue) ? parsedValue : Number.MAX_SAFE_INTEGER;
}

function sortProductsByCategoryAndBrand(products) {
    const order = new Map(categoryOrder.map((category, index) => [category, index]));
    const extras = [...new Set(products.map(item => String(item?.category || "أخرى").trim()).filter(Boolean))]
        .filter(category => !order.has(category))
        .sort((a, b) => a.localeCompare(b, "ar", { sensitivity: "base" }));
    extras.forEach(category => order.set(category, order.size));
    return [...products].sort((a, b) => compareProductsByCategoryAndBrand(a, b, order));
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

function latestUpdate(productId) {
    return latestPriceUpdates.get(productId) || null;
}

function priceMarkup(product, update) {
    const formatCurrency = value => {
        const number = Number(value || 0);
        return Number.isFinite(number) ? number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
    };
    if (update && String(update.price) === String(product.price)) {
        return `<span class="modal-old-price">${escapeHtml(formatCurrency(update.oldPrice))} ج.م</span><span class="modal-new-price">${escapeHtml(formatCurrency(product.price))} ج.م</span>`;
    }
    return `<span class="modal-new-price">${escapeHtml(formatCurrency(product.price))} ج.م</span>`;
}

function parseFirestoreValue(value) {
    if (!value || typeof value !== "object") return value;
    if ("stringValue" in value) return value.stringValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return Number(value.doubleValue);
    if ("timestampValue" in value) return value.timestampValue;
    if ("referenceValue" in value) return value.referenceValue;
    if ("bytesValue" in value) return value.bytesValue;
    if ("nullValue" in value) return null;
    if ("arrayValue" in value) return (value.arrayValue.values || []).map(parseFirestoreValue);
    if ("mapValue" in value) return Object.fromEntries(
        Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, parseFirestoreValue(item)])
    );
    return value;
}

function parseFirestoreDocument(document) {
    const id = String(document.name || "").split("/").pop();
    return {
        id,
        ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, parseFirestoreValue(value)]))
    };
}

async function fetchFirestoreCollection(collectionName, onBatch) {
    const documents = [];
    let pageToken = "";

    do {
        const params = new URLSearchParams({ pageSize: "1000" });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await fetchWithRetry(`${FIRESTORE_API_ROOT}/${collectionName}?${params}`, { retries: 1, timeoutMs: 3000 });
        if (!response.ok) throw new Error(`FIRESTORE_${response.status}`);
        const payload = await response.json();
        const batch = (payload.documents || []).map(parseFirestoreDocument);
        documents.push(...batch);
        if (typeof onBatch === "function" && batch.length) onBatch(batch, documents.length);
        pageToken = payload.nextPageToken || "";
    } while (pageToken);

    return documents;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(operation, options = {}) {
    const retries = Number.isInteger(options.retries) ? options.retries : 2;
    const baseDelay = Number(options.baseDelay) || 400;
    const maxDelay = Number(options.maxDelay) || 2400;

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= retries) throw error;
            await wait(Math.min(maxDelay, baseDelay * (2 ** attempt)));
        }
    }
}

async function fetchWithRetry(url, options = {}) {
    const { retries = 2, timeoutMs = 5000, ...requestOptions } = options;
    return retryWithBackoff(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...requestOptions, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP_${response.status}`);
            return response;
        } finally {
            clearTimeout(timeoutId);
        }
    }, { retries });
}

function cardPriceMarkup(product, update) {
    if (update && String(update.price) === String(product.price)) {
        return `<span class="card-old-price">${escapeHtml(update.oldPrice ?? 0)} جنيه</span><span class="card-new-price">${escapeHtml(product.price ?? 0)} جنيه</span>`;
    }
    return `<span class="card-new-price">${escapeHtml(product.price ?? 0)} جنيه</span>`;
}

function showProductModal(product) {
    const name = productName(product);
    const parts = productParts(product);
    const update = latestUpdate(product.id);
    modalImage.src = productImage(product) || PRODUCT_IMAGE_FALLBACK;
    modalImage.onerror = () => {
        modalImage.onerror = null;
        modalImage.src = PRODUCT_IMAGE_FALLBACK;
    };
    modalImage.alt = name;
    modalName.textContent = parts.main;
    modalBadge.textContent = parts.badge;
    modalBadge.hidden = !parts.badge;
    modalPrice.innerHTML = priceMarkup(product, update);
    modalBarcode.textContent = `الباركود: ${product.barcode || "بدون باركود"}`;
    modalCategory.textContent = `القسم: ${product.category || "غير محدد"}`;
    modalUpdatedAt.textContent = dateText(update?.timestamp || product.updatedAt || product.createdAt);
    modalUpdatedAt.hidden = !modalUpdatedAt.textContent;
    modal.classList.add("show");
}

function updateProductCard(card, product) {
        const name = productName(product);
        const parts = productParts(product);
        const update = latestUpdate(product.id);
        card.innerHTML = `
            <div class="card-image-box"><img loading="lazy" decoding="async" alt="${escapeHtml(name)}" src="${escapeHtml(productImage(product) || PRODUCT_IMAGE_FALLBACK)}"></div>
            <div class="card-body">
                <h3 class="product-name">
                    <span class="product-name-main">${escapeHtml(parts.main)}</span>
                    ${parts.badge ? `<span class="product-name-badge">${escapeHtml(parts.badge)}</span>` : ""}
                </h3>
                <span class="product-category">${escapeHtml(String(product.category || "").trim())}</span>
                <span class="price">${cardPriceMarkup(product, update)}</span>
            </div>`;
        const cardImage = card.querySelector("img");
        cardImage.addEventListener("error", () => {
            cardImage.onerror = null;
            cardImage.src = PRODUCT_IMAGE_FALLBACK;
        }, { once: true });
}

function createProductCard(product) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.productId = product.id;
    updateProductCard(card, product);
    return card;
}

function renderProducts(products, emptyMessage = "لا توجد منتجات متاحة حالياً") {
    activeProductResults = sortProductsByCategoryAndBrand(products);
    productGrid.replaceChildren();
    if (!products.length) {
        productGrid.innerHTML = `<div class="no-results" style="grid-column:1/-1;text-align:center;padding:30px;color:var(--muted)">${emptyMessage}</div>`;
        if (loadMoreProductsButton) loadMoreProductsButton.hidden = true;
        return;
    }

    const fragment = document.createDocumentFragment();
    activeProductResults.slice(0, visibleProductCount).forEach(product => {
        fragment.appendChild(createProductCard(product));
    });
    productGrid.appendChild(fragment);
    if (loadMoreProductsButton) {
        loadMoreProductsButton.hidden = visibleProductCount >= activeProductResults.length;
    }
}

function applyProductSnapshotChanges(changes) {
    renderProducts(allProducts);
}

function renderCategories() {
    const productCategories = [...new Set(allProducts.map(product => String(product.category || "").trim()).filter(Boolean))];
    const categories = [
        ...categoryOrder.filter(category => productCategories.includes(category)),
        ...productCategories.filter(category => !categoryOrder.includes(category)).sort((a, b) => a.localeCompare(b, "ar"))
    ];
    categoriesContainer.replaceChildren();
    ["الكل", ...categories].forEach((category, index) => {
        const button = document.createElement("button");
        button.className = `category${index === 0 ? " active" : ""}`;
        button.textContent = category;
        button.dataset.category = category;
        categoriesContainer.appendChild(button);
    });
}

function applyLatestUpdates(updates) {
    latestPriceUpdates = new Map();
    updates.forEach(update => {
        const current = latestPriceUpdates.get(update.productId);
        const time = getUpdateTime(update);
        const currentTime = getUpdateTime(current);
        if (!current || time > currentTime) latestPriceUpdates.set(update.productId, update);
    });
}

function getUpdateTime(update) {
    const value = update?.timestamp ?? update?.updateId;
    if (value?.toMillis instanceof Function) return value.toMillis();
    if (value?.seconds !== undefined) return Number(value.seconds) * 1000;
    if (typeof value === "number") return Number.isFinite(value) ? value : -Infinity;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : -Infinity;
}

function startLiveSync() {
    if (liveSyncStarted) return;
    liveSyncStarted = true;
    if (!window.firebase) {
        loadProductsFallback();
        return;
    }

    try {
        if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig);
    } catch (error) {
        handleLiveSyncError(error);
        return;
    }

    liveUnsubscribers.forEach(unsubscribe => unsubscribe());
    const firestore = window.firebase.firestore();
    liveUnsubscribers = [
        firestore.collection(PRODUCTS_COLLECTION).onSnapshot(snapshot => {
            hasLiveProductsSnapshot = true;
            const changes = snapshot.docChanges();
            const productsById = new Map(allProducts.map(product => [product.id, product]));
            changes.forEach(change => {
                if (change.type === "removed") productsById.delete(change.doc.id);
                else productsById.set(change.doc.id, { id: change.doc.id, ...change.doc.data() });
            });
            allProducts = [...productsById.values()];
            renderCategories();
            applyProductSnapshotChanges(changes);
        }, handleLiveSyncError),
        firestore.collection(PRICE_UPDATES_COLLECTION).onSnapshot(snapshot => {
            applyLatestUpdates(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            renderProducts(allProducts);
        }, handleLiveSyncError),
        firestore.collection("app_settings").doc("productCategories").onSnapshot(snapshot => {
            const categories = snapshot.data()?.categories;
            if (Array.isArray(categories)) {
                categoryOrder = [...new Set(categories.map(category => String(category).trim()).filter(Boolean))];
                renderCategories();
                renderProducts(allProducts);
            }
        }, handleLiveSyncError)
    ];
}

function handleLiveSyncError(error) {
    console.error("تعذر مزامنة البيانات فورياً:", error);
    if (!allProducts.length) {
        loadProductsFallback();
    }
}

async function loadProductsFallback() {
    if (hasLiveProductsSnapshot) return;
    if (fallbackLoadPromise) return fallbackLoadPromise;

    fallbackLoadPromise = (async () => {
        const [products, categoryDocument, updates] = await Promise.all([
            fetchFirestoreCollection(PRODUCTS_COLLECTION),
            fetchWithRetry(`${FIRESTORE_API_ROOT}/app_settings/productCategories`, { retries: 1, timeoutMs: 3000 }).then(response => response.json()).catch(() => null),
            fetchFirestoreCollection(PRICE_UPDATES_COLLECTION)
        ]);

        if (hasLiveProductsSnapshot) return;

        allProducts = products;
        const savedCategories = categoryDocument?.fields?.categories;
        const parsedCategories = savedCategories ? parseFirestoreValue(savedCategories) : null;
        if (Array.isArray(parsedCategories)) categoryOrder = parsedCategories.map(category => String(category).trim()).filter(Boolean);
        applyLatestUpdates(updates);
        renderCategories();
        renderProducts(allProducts);
    })().catch(error => {
        console.error("تعذر تحميل المنتجات احتياطياً:", error);
        if (!allProducts.length) {
            productGrid.innerHTML = `<div class="no-results" style="grid-column:1/-1;text-align:center;padding:30px;color:var(--muted)">تعذر تحميل المنتجات حالياً</div>`;
        }
    });

    return fallbackLoadPromise;
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

startLiveSync();
