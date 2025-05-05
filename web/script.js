// Global variables
let currentView = 'dashboard';
let accountsData = []; // Cache for account names/ids/balances
let categoryData = []; // Cache for category names/ids/types
let currentBudgetData = {}; // Cache for budget view data {cat_id: {budget_data}}
let currentBudgetMonth = ''; // Currently selected budget month YYYY-MM
let spendingChart = null; // Global reference for the chart instance
let themeToggle; // Declare globally, assign AFTER DOM ready

// Debounce helper
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

console.log("Script Loaded. Initializing...");

// --- Theme Handling Functions ---
// Applies visual changes AND sets toggle state
function applyThemeAndToggle(theme) {
    themeToggle = themeToggle || document.getElementById('theme-toggle'); // Ensure reference

    // Apply class to HTML element for CSS targeting
    if (theme === 'dark') {
        document.documentElement.classList.add('dark-theme');
        if (themeToggle) themeToggle.checked = true; // Set toggle state
        console.log("JS applyThemeAndToggle: Applied Dark");
    } else { // Default to light
        document.documentElement.classList.remove('dark-theme');
        if (themeToggle) themeToggle.checked = false; // Set toggle state
        console.log("JS applyThemeAndToggle: Applied Light");
    }

    // Update chart appearance if needed
    if (currentView === 'reports' && spendingChart) {
         try {
             console.log("Theme changed, updating chart appearance.");
              const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
              const borderColor = document.documentElement.classList.contains('dark-theme') ? '#2D3748' : '#FFFFFF';
              spendingChart.options.plugins.legend.labels.color = textColor;
              spendingChart.data.datasets[0].borderColor = borderColor;
              spendingChart.data.datasets[0].backgroundColor = generateChartColors(spendingChart.data.datasets[0].data.length);
              spendingChart.update();
         } catch (e) { console.error("Error updating chart theme:", e); }
    }
}

// Saves theme preference using the backend API
async function saveThemePreference(theme) {
     // Ensure API is ready before trying to save
     const isReady = await waitForPywebview(); // Use await here
     if (isReady && window.pywebview?.api?.save_theme_preference) {
         try {
            console.log(`JS saveThemePreference: Calling backend to save '${theme}'`);
            const result = await callPython('save_theme_preference', theme); // await the call
            if (!result?.success) {
                console.warn("Backend failed to save theme preference.");
                // Toast is handled by callPython if backend sent an error message
                if (!result?.error) { // Show generic only if backend didn't specify
                    showToast("Could not save theme preference.", "warning");
                }
            } else {
                 console.log(`JS saveThemePreference: Backend confirmed save for '${theme}'`);
            }
         } catch (e) {
             console.error("Error calling save_theme_preference:", e);
             showToast("Error communicating with backend to save theme.", "error");
         }
    } else {
        console.warn("API or save_theme_preference function not available when trying to save theme.");
        showToast("Cannot save theme preference - backend unavailable.", "warning");
    }
}


// Handles the user clicking the toggle - saves preference via backend
async function handleThemeToggle() {
    themeToggle = themeToggle || document.getElementById('theme-toggle');
    if (themeToggle) {
        const newTheme = themeToggle.checked ? 'dark' : 'light';
        applyThemeAndToggle(newTheme); // Update visuals immediately
        await saveThemePreference(newTheme);
    } else {
        console.error("Theme toggle element not found in handleThemeToggle");
    }
}
// --- End Theme Handling ---


// --- Toast Notification Helper ---
function showToast(message, type = 'info') {
    if (typeof Toastify !== 'function') { console.warn('Toastify not loaded:', message); alert(`${type.toUpperCase()}: ${message}`); return; }
    const backgrounds = { success: "linear-gradient(to right, #00b09b, #96c93d)", error: "linear-gradient(to right, #ff5f6d, #ffc371)", warning: "linear-gradient(to right, #f7b733, #fc4a1a)", info: "linear-gradient(to right, #007bff, #00bfff)", };
    Toastify({ text: message, duration: 3500, newWindow: true, close: true, gravity: "top", position: "right", stopOnFocus: true, style: { background: backgrounds[type] || backgrounds.info, borderRadius: "6px", minWidth: "250px", boxShadow: "0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23)", }, }).showToast();
}

// --- API Call Wrapper ---
async function waitForPywebview(timeoutMs = 5000) {
    const start = Date.now();
    while (!window.pywebview?.api && (Date.now() - start < timeoutMs)) { await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!window.pywebview?.api) { console.error("pywebview API object not found after timeout."); showToast("Error: Backend connection timed out.", 'error'); return false; }
    // Check essential functions exist
    const essentialFunctions = [
        'get_accounts', 'add_account', 'delete_account', 'update_account',
        'get_transactions', 'add_transaction', 'delete_transaction', 'update_transaction', 'get_transaction_details',
        'get_categories', 'add_category', 'delete_category', 'update_category',
        'get_budget_data_for_month', 'set_budget_amount',
        'get_spending_by_category_report',
        'get_dashboard_data',
        'export_data_to_excel',
        'get_theme_preference', 
        'save_theme_preference'
     ];
    for (const funcName of essentialFunctions) {
       if (typeof window.pywebview.api[funcName] !== 'function') {
             console.error(`pywebview API object found, but essential function '${funcName}' is missing.`);
             showToast(`Error: Backend API is incomplete (Missing: ${funcName}).`, 'error');
             return false;
        }
    }
    return true;
}
async function callPython(funcName, ...args) {
    // Direct check before call:
    if (!window.pywebview?.api?.[funcName] || typeof window.pywebview.api[funcName] !== 'function') {
        const errorMsg = `Python function '${funcName}' not available.`;
        console.error(`JS Error: ${errorMsg}`);
        showToast(errorMsg, 'error');
        return { success: false, error: errorMsg };
    }

    try {
        const stringArgs = args.map(arg => (arg === null || arg === undefined) ? null : String(arg));
        // console.debug(`-> PY [${funcName}] Request:`, stringArgs); // Verbose debug
        const resultString = await window.pywebview.api[funcName](...stringArgs);
        // console.debug(`<- PY [${funcName}] Raw Response:`, resultString); // Verbose debug
        let parsedResult;
        try { parsedResult = JSON.parse(resultString); }
        catch (parseError) { console.error(`JS Error parsing JSON from ${funcName}:`, parseError, "\nRaw Response:", resultString); showToast(`Error processing server response (${funcName}).`, 'error'); return { success: false, error: `JSON Parse Error: ${parseError.message}` }; }

        if (typeof parsedResult.success === 'boolean') {
            if (!parsedResult.success && parsedResult.error) {
                console.error(`<- PY [${funcName}] Failed:`, parsedResult.error);
                showToast(parsedResult.error, 'error'); // Show backend error
            }
            return parsedResult;
        } else {
            console.warn(`<- PY [${funcName}] Response format unexpected:`, parsedResult);
            showToast(`Unexpected response format from ${funcName}.`, 'warning');
            return { success: false, error: "Unexpected response format.", data: parsedResult };
        }
    } catch (error) {
        console.error(`JS Error during API call ${funcName}:`, error);
        let errorMessage = `Frontend error calling ${funcName}: ${error.message}`;
        if (error.name === 'Error' && error.message.includes('Traceback')) { errorMessage = `Error in backend function ${funcName}. Check Python logs.`; console.error("Potential Python backend error details:", error.message); }
        showToast(errorMessage, 'error');
        return { success: false, error: `JavaScript Error: ${error.message}` };
    }
}

// --- View Switching ---
function switchView(viewId) {
    document.querySelectorAll('.view').forEach(view => { view.classList.remove('active-view'); });
    const targetView = document.getElementById(`${viewId}-view`);
    if (targetView) {
        targetView.classList.add('active-view'); currentView = viewId; updateActiveNavButton(viewId);
        setTimeout(() => {
            console.log(`Loading data for view: ${viewId}`);
            switch (viewId) {
                case 'accounts': loadAccountsData(); break;
                case 'transactions': loadTransactionsData(); break;
                case 'dashboard': loadDashboardData(); break;
                case 'categories': loadCategoriesData(); break;
                case 'budget': loadBudgetData(); break;
                case 'reports': loadReportsData(); break;
                case 'settings': /* No load needed */ break;
            }
        }, 0);
    } else { console.error(`View element not found: ${viewId}-view`); showToast(`Failed to switch to view: ${viewId}`, 'error'); }
}
function updateActiveNavButton(activeViewId) {
    document.querySelectorAll('.nav-button').forEach(button => { button.classList.toggle('active', button.dataset.view === activeViewId); });
}

// --- Modal Handling ---
async function openModal(modalId) {
    const modal = document.getElementById(modalId); if (!modal) { console.error("Modal element not found:", modalId); return; }
    if (modalId.includes('transaction') || modalId.includes('budget')) { await ensureInitialData(); } // Ensure data before opening
    if (modalId.includes('transaction')) { if (!accountsData || accountsData.length === 0) { showToast("No accounts available.", 'warning'); return; } populateAccountDropdowns(modalId.replace('-modal', '-acc')); populateCategoryDropdowns(modalId.replace('-modal', '-cat')); }
    if (modalId === 'add-transaction-modal') { const dateInput = document.getElementById('trans-date'); if (dateInput && !dateInput.value) { dateInput.valueAsDate = new Date(); } const accSelect = document.getElementById('trans-acc'); if (accountsData.length === 1 && accSelect) { accSelect.value = accountsData[0].id; } const typeSelect = document.getElementById('trans-type'); if (typeSelect) typeSelect.value = 'expense'; }
    modal.classList.add('active'); setTimeout(() => { const firstInput = modal.querySelector('form input:not([type=hidden]):not([disabled]), form select:not([disabled]), form textarea:not([disabled])'); firstInput?.focus(); }, 150);
}
function closeModal(modalId) {
     const modal = document.getElementById(modalId); if (modal) { modal.classList.remove('active'); const form = modal.querySelector('form'); if (form) { form.reset(); } const addTypeSelect = document.getElementById('trans-type'); if (addTypeSelect) addTypeSelect.value = 'expense'; const editTypeSelect = document.getElementById('edit-trans-type'); if (editTypeSelect) editTypeSelect.value = 'expense'; }
}

// --- Rendering Helpers ---
function renderPlaceholder(containerElement, type = 'loading', customMessage = null) {
    if (!containerElement) return; const messages = { loading: 'Loading...', empty: 'No items found.', error: 'Error loading data.', info: '' }; const icons = { loading: 'hourglass_top', empty: 'sentiment_dissatisfied', error: 'error_outline', info: 'info_outline' }; const message = customMessage ?? messages[type] ?? messages.loading; const icon = icons[type] ?? icons.loading; containerElement.innerHTML = `<p class="placeholder-text ${type}"><span class="material-symbols-outlined">${icon}</span> ${message}</p>`;
}
function renderTableRow(itemData, type) {
     const row = document.createElement('div'); row.className = 'table-row'; row.dataset.id = itemData.id; try { switch (type) { case 'account': { const balance = parseFloat(itemData.current_balance ?? '0'); row.innerHTML = `<div class="td col-name">${escapeHtml(itemData.name)}</div> <div class="td col-balance ${balance >= 0 ? 'positive' : 'negative'}">${formatCurrency(itemData.current_balance)}</div> <div class="td col-actions"> <div class="action-buttons"> <button class="button action-btn" onclick="editAccount(${itemData.id})" title="Edit Account"><span class="material-symbols-outlined">edit</span></button> <button class="button action-btn danger" onclick="deleteAccount(${itemData.id}, '${escapeJsString(itemData.name)}')" title="Delete Account"><span class="material-symbols-outlined">delete</span></button> </div> </div>`; break; } case 'transaction': { const amount = parseFloat(itemData.amount ?? '0'); row.innerHTML = `<div class="td col-date">${escapeHtml(itemData.date)}</div> <div class="td col-account">${escapeHtml(itemData.account_name)}</div> <div class="td col-desc" title="${escapeHtml(itemData.description)}">${escapeHtml(itemData.description)}</div> <div class="td col-cat">${escapeHtml(itemData.category_name || 'Uncategorized')}</div> <div class="td col-amount ${amount >= 0 ? 'positive' : 'negative'}">${formatCurrency(itemData.amount)}</div> <div class="td col-actions"> <div class="action-buttons"> <button class="button action-btn" onclick="editTransaction(${itemData.id})" title="Edit Transaction"><span class="material-symbols-outlined">edit</span></button> <button class="button action-btn danger" onclick="deleteTransaction(${itemData.id})" title="Delete Transaction"><span class="material-symbols-outlined">delete</span></button> </div> </div>`; break; } case 'category': { const isUncategorized = itemData.name.toLowerCase() === 'uncategorized'; row.innerHTML = `<div class="td col-cat-name">${escapeHtml(itemData.name)}</div> <div class="td col-cat-type">${escapeHtml(itemData.type)}</div> <div class="td col-actions"> <div class="action-buttons"> <button class="button action-btn" onclick="editCategory(${itemData.id}, '${escapeJsString(itemData.name)}', '${itemData.type}')" title="Edit Category" ${isUncategorized ? 'disabled' : ''}><span class="material-symbols-outlined">edit</span></button> <button class="button action-btn danger" onclick="deleteCategory(${itemData.id}, '${escapeJsString(itemData.name)}')" title="Delete Category" ${isUncategorized ? 'disabled' : ''}><span class="material-symbols-outlined">delete</span></button> </div> </div>`; break; } case 'budget': { const budgeted = parseFloat(itemData.budgeted_amount || '0'); const spent = parseFloat(itemData.spent_amount || '0'); const remaining = parseFloat(itemData.remaining_amount || '0'); let progress = 0; if (budgeted > 0) { progress = (spent / budgeted) * 100; } else if (spent > 0) { progress = Infinity; } const isOverBudget = budgeted > 0 && spent > budgeted; const displayProgress = budgeted > 0 ? Math.min(100, progress) : 0; let progressTitle = `${progress.toFixed(1)}% Spent`; if (progress === Infinity) progressTitle = "Spending with zero budget"; if (isOverBudget) progressTitle += ' (Over Budget!)'; row.innerHTML = `<div class="td col-cat-name">${escapeHtml(itemData.category_name)}</div> <div class="td col-budgeted"> <input type="text" value="${Number(budgeted).toFixed(2)}" data-category-id="${itemData.category_id}" class="budget-input" placeholder="0.00" inputmode="decimal" pattern="\\d*([.,]\\d{0,2})?$" title="Enter budget amount"> </div> <div class="td col-spent ${spent > 0 ? 'negative' : ''}">${formatCurrency(spent > 0 ? -spent : 0)}</div> <div class="td col-remaining ${remaining >= 0 ? 'positive' : 'negative'}">${formatCurrency(remaining)}</div> <div class="td col-progress"> <div class="budget-progress-bar" title="${progressTitle}"> <div class="budget-progress-bar-inner ${isOverBudget ? 'over-budget' : ''} ${progress === Infinity ? 'infinite-progress' : ''}" style="width: ${displayProgress}%"></div> </div> </div>`; break; } default: console.warn(`Unknown row type: ${type}`); row.innerHTML = `<div class="td error" colspan="5">Unknown row type</div>`; } } catch (error) { console.error("Error rendering table row:", error, "Data:", itemData, "Type:", type); row.innerHTML = `<div class="td error" colspan="5">Render Error</div>`; } return row;
}

// --- Data Loading Functions ---
async function loadAccountsData() { const tableBody = document.getElementById('accounts-table-body'); if (!tableBody) return; renderPlaceholder(tableBody, 'loading'); const result = await callPython('get_accounts'); tableBody.innerHTML = ''; if (result?.success && result.data?.accounts) { accountsData = result.data.accounts; if (accountsData.length === 0) { renderPlaceholder(tableBody, 'empty', 'No accounts found. Click "Add Account".'); } else { accountsData.forEach(acc => tableBody.appendChild(renderTableRow(acc, 'account'))); } populateAccountDropdowns(); } else { renderPlaceholder(tableBody, 'error', result?.error || 'Failed to load accounts.'); accountsData = []; populateAccountDropdowns(); } }
async function loadTransactionsData(accountId = null, limit = null) { const tableBody = document.getElementById('transactions-table-body'); if (!tableBody) return; renderPlaceholder(tableBody, 'loading'); const result = await callPython('get_transactions', accountId ? String(accountId) : null, limit ? String(limit) : null); tableBody.innerHTML = ''; if (result?.success && result.data?.transactions) { if (result.data.transactions.length === 0) { renderPlaceholder(tableBody, 'empty', accountId ? 'No transactions for this account.' : 'No transactions recorded yet.'); } else { result.data.transactions.forEach(tran => tableBody.appendChild(renderTableRow(tran, 'transaction'))); } } else { renderPlaceholder(tableBody, 'error', result?.error || 'Failed to load transactions.'); } }
async function loadDashboardData() { console.log("Loading dashboard data..."); const dbAccountList = document.getElementById('db-account-list'); const dbTransList = document.getElementById('db-recent-transactions'); const totalBalanceElem = document.getElementById('db-total-balance'); const accountCountElem = document.getElementById('db-account-count'); const monthlyFlowElem = document.getElementById('db-monthly-flow'); const monthlyFlowCard = monthlyFlowElem?.closest('.card'); if (dbAccountList) renderPlaceholder(dbAccountList, 'loading'); if (dbTransList) renderPlaceholder(dbTransList, 'loading'); if (totalBalanceElem) totalBalanceElem.textContent = '...'; if (accountCountElem) accountCountElem.textContent = '...'; if (monthlyFlowElem) monthlyFlowElem.textContent = '--'; if (monthlyFlowCard) monthlyFlowCard.classList.add('placeholder'); const result = await callPython('get_dashboard_data'); if (result?.success && result.data) { const data = result.data; const totalBalance = parseFloat(data.total_balance ?? '0'); if (totalBalanceElem) { totalBalanceElem.textContent = formatCurrency(totalBalance); totalBalanceElem.className = `card-value large ${totalBalance >= 0 ? 'positive' : 'negative'}`; } const accountCount = data.account_count ?? 0; if (accountCountElem) { accountCountElem.textContent = accountCount; } const monthlyFlow = parseFloat(data.monthly_flow ?? '0'); if (monthlyFlowElem) { monthlyFlowElem.textContent = formatCurrency(monthlyFlow); monthlyFlowElem.className = `card-value ${monthlyFlow >= 0 ? 'positive' : 'negative'}`; monthlyFlowElem.style.fontSize = '1.5rem'; monthlyFlowElem.style.color = ''; } if (monthlyFlowCard) monthlyFlowCard.classList.remove('placeholder'); if (dbAccountList) { dbAccountList.innerHTML = ''; const accounts = data.accounts || []; if (accountCount > 0 && accounts.length > 0) { accounts.forEach(acc => { const balance = parseFloat(acc.current_balance ?? '0'); const item = document.createElement('div'); item.className = 'list-item'; item.innerHTML = `<span class="account-name">${escapeHtml(acc.name)}</span> <span class="amount ${balance >= 0 ? 'positive' : 'negative'}">${formatCurrency(acc.current_balance)}</span>`; dbAccountList.appendChild(item); }); } else { renderPlaceholder(dbAccountList, 'empty', 'No accounts yet.'); } } if (dbTransList) { dbTransList.innerHTML = ''; const transactions = data.recent_transactions || []; if (transactions.length > 0) { transactions.forEach(tran => { const amount = parseFloat(tran.amount ?? '0'); const item = document.createElement('div'); item.className = 'list-item'; const accountNameChip = accountCount > 1 ? `<span class="trans-account-chip">${escapeHtml(tran.account_name)}</span>` : ''; const categoryChip = tran.category_name && tran.category_name !== 'Uncategorized' ? `<span class="trans-cat-chip">${escapeHtml(tran.category_name)}</span>` : ''; item.innerHTML = `<span class="transaction-info"><span class="trans-date">${escapeHtml(tran.date)}:</span> <span class="trans-desc">${escapeHtml(tran.description)}</span> ${categoryChip} ${accountNameChip}</span> <span class="amount ${amount >= 0 ? 'positive' : 'negative'}">${formatCurrency(tran.amount)}</span>`; dbTransList.appendChild(item); }); } else if (accountCount > 0) { renderPlaceholder(dbTransList, 'empty', 'No recent transactions.'); } else { renderPlaceholder(dbTransList, 'info', 'Add an account to start tracking activity.'); } } } else { console.error("Failed to load dashboard data:", result?.error); if (totalBalanceElem) totalBalanceElem.textContent = 'Error'; if (accountCountElem) accountCountElem.textContent = 'Error'; if (monthlyFlowElem) monthlyFlowElem.textContent = 'Error'; if (monthlyFlowCard) monthlyFlowCard.classList.remove('placeholder'); if (dbAccountList) renderPlaceholder(dbAccountList, 'error', 'Failed to load accounts.'); if (dbTransList) renderPlaceholder(dbTransList, 'error', 'Failed to load transactions.'); } console.log("Dashboard data loading finished."); }
async function loadCategoriesData() { const tableBody = document.getElementById('categories-table-body'); if (!tableBody) return; renderPlaceholder(tableBody, 'loading'); const result = await callPython('get_categories'); tableBody.innerHTML = ''; if (result?.success && result.data?.categories) { categoryData = result.data.categories; const customCategories = categoryData.filter(c => c.name.toLowerCase() !== 'uncategorized'); if (customCategories.length === 0) { renderPlaceholder(tableBody, 'empty', 'No custom categories. Click "Add Category".'); } const sortedForDisplay = [...categoryData].sort((a, b) => { if (a.name.toLowerCase() === 'uncategorized') return 1; if (b.name.toLowerCase() === 'uncategorized') return -1; if (a.type !== b.type) return a.type.localeCompare(b.type); return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); }); sortedForDisplay.forEach(cat => tableBody.appendChild(renderTableRow(cat, 'category'))); populateCategoryDropdowns(); } else { renderPlaceholder(tableBody, 'error', result?.error || 'Failed to load categories.'); categoryData = []; populateCategoryDropdowns(); } }
async function loadBudgetData() { const tableBody = document.getElementById('budget-table-body'); const monthInput = document.getElementById('budget-month'); if (!tableBody || !monthInput) { console.error("Budget UI elements missing."); return; } if (!monthInput.value) { const today = new Date(); monthInput.value = today.toISOString().slice(0, 7); } currentBudgetMonth = monthInput.value; renderPlaceholder(tableBody, 'loading'); const result = await callPython('get_budget_data_for_month', currentBudgetMonth); tableBody.innerHTML = ''; if (result?.success && result.data?.budget_data) { currentBudgetData = {}; const budgetItems = result.data.budget_data; if (budgetItems.length === 0) { const allCategoriesResult = await callPython('get_categories', 'expense'); if (allCategoriesResult?.success && allCategoriesResult.data?.categories?.length > 0 && !allCategoriesResult.data.categories.every(c => c.name.toLowerCase() === 'uncategorized')) { renderPlaceholder(tableBody, 'info', 'No budgets set for this month.'); } else { renderPlaceholder(tableBody, 'info', 'Add expense categories first.'); } } else { budgetItems.forEach(b => { currentBudgetData[b.category_id] = b; tableBody.appendChild(renderTableRow(b, 'budget')); }); } } else { renderPlaceholder(tableBody, 'error', result?.error || 'Failed to load budget data.'); currentBudgetData = {}; } }
async function loadReportsData() { const startDateInput = document.getElementById('report-start-date'); const endDateInput = document.getElementById('report-end-date'); const chartContainer = document.getElementById('spending-chart-container'); const placeholder = document.getElementById('report-placeholder'); const canvas = document.getElementById('spending-pie-chart'); if (!startDateInput || !endDateInput || !chartContainer || !placeholder || !canvas) { console.error("Report UI elements missing."); return; } if (!startDateInput.value || !endDateInput.value) { const today = new Date(); const firstDay = new Date(today.getFullYear(), today.getMonth(), 1); const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0); startDateInput.value = firstDay.toISOString().split('T')[0]; endDateInput.value = lastDay.toISOString().split('T')[0]; } if (spendingChart) { spendingChart.destroy(); spendingChart = null; } canvas.style.display = 'none'; placeholder.style.display = 'block'; placeholder.className = 'placeholder-text info'; placeholder.innerHTML = '<span class="material-symbols-outlined">info_outline</span> Select dates and click "Run Report".'; }

// --- Action Handlers (Forms, Buttons) ---
async function handleAddAccount(event) { event.preventDefault(); const form = event.target; const nameInput = form.elements['acc-name']; const balanceInput = form.elements['acc-balance']; const name = nameInput?.value.trim(); const balance = balanceInput?.value; if (!name) { showToast("Account name cannot be empty.", 'warning'); nameInput?.focus(); return; } if (balance && !/^-?\d*([.,]?\d{0,2})?$/.test(balance.trim())) { showToast("Invalid balance format.", 'warning'); balanceInput?.focus(); return; } const result = await callPython('add_account', name, balance); if (result?.success) { showToast(`Account '${name}' added.`, 'success'); closeModal('add-account-modal'); if (currentView === 'accounts') await loadAccountsData(); if (currentView === 'dashboard') await loadDashboardData(); await ensureInitialData(true); } else { nameInput?.focus(); } }
async function deleteAccount(id, name) { if (confirm(`ARE YOU SURE?\nDeleting account "${escapeJsString(name)}" will also PERMANENTLY DELETE all its transactions!`)) { const result = await callPython('delete_account', String(id)); if (result?.success) { showToast(`Account '${name}' deleted.`, 'success'); if (currentView === 'accounts') await loadAccountsData(); if (currentView === 'dashboard') await loadDashboardData(); if (currentView === 'transactions') { const filterSelect = document.getElementById('account-filter'); if (filterSelect) filterSelect.value = 'null'; await loadTransactionsData(null); } await ensureInitialData(true); } } }
async function editAccount(id) { let account = accountsData.find(acc => acc.id === id); if (!account) { await loadAccountsData(); account = accountsData.find(acc => acc.id === id); } if (account) { document.getElementById('edit-acc-id').value = account.id; document.getElementById('edit-acc-name').value = account.name; document.getElementById('edit-acc-balance').value = parseFloat(account.initial_balance ?? '0').toFixed(2); openModal('edit-account-modal'); } else { showToast("Error: Account not found.", 'error'); } }
async function handleEditAccount(event) { event.preventDefault(); const form = event.target; const id = form.elements['edit-acc-id']?.value; const nameInput = form.elements['edit-acc-name']; const balanceInput = form.elements['edit-acc-balance']; const name = nameInput?.value.trim(); const balance = balanceInput?.value; if (!id) { console.error("Edit account ID missing!"); return; } if (!name) { showToast("Account name cannot be empty.", 'warning'); nameInput?.focus(); return; } if (balance && !/^-?\d*([.,]?\d{0,2})?$/.test(balance.trim())) { showToast("Invalid balance format.", 'warning'); balanceInput?.focus(); return; } const result = await callPython('update_account', String(id), name, balance); if (result?.success) { showToast(`Account '${name}' updated.`, 'success'); closeModal('edit-account-modal'); if (currentView === 'accounts') await loadAccountsData(); if (currentView === 'dashboard') await loadDashboardData(); await ensureInitialData(true); } else { nameInput?.focus(); } }
async function handleAddTransaction(event) { event.preventDefault(); const form = event.target; const accountId = form.elements['trans-acc']?.value; const date = form.elements['trans-date']?.value; const descriptionInput = form.elements['trans-desc']; const typeSelect = form.elements['trans-type']; const transactionType = typeSelect?.value; const amountInput = form.elements['trans-amount']; const categoryId = form.elements['trans-cat']?.value || null; const description = descriptionInput?.value.trim(); let amountStr = amountInput?.value.trim().replace(',', '.'); if (!amountStr || !/^\d*\.?\d{0,2}$/.test(amountStr) || parseFloat(amountStr) < 0) { showToast("Invalid amount format. Enter a positive number.", 'warning'); amountInput?.focus(); return; } const amountToSend = (transactionType === 'expense') ? `-${amountStr}` : amountStr; if (!accountId) { showToast("Please select an account.", 'warning'); form.elements['trans-acc']?.focus(); return; } if (!date) { showToast("Please select a date.", 'warning'); form.elements['trans-date']?.focus(); return; } if (!description) { showToast("Description cannot be empty.", 'warning'); descriptionInput?.focus(); return; } if (!transactionType) { showToast("Please select a transaction type.", 'warning'); typeSelect?.focus(); return; } const result = await callPython('add_transaction', String(accountId), date, description, amountToSend, categoryId ? String(categoryId) : null ); if (result?.success) { showToast('Transaction added.', 'success'); closeModal('add-transaction-modal'); const currentFilter = document.getElementById('account-filter')?.value; if (currentView === 'transactions') await loadTransactionsData(currentFilter === 'null' ? null : currentFilter); if (currentView === 'dashboard') await loadDashboardData(); if (currentView === 'budget') await loadBudgetData(); await loadAccountsData(); } else { form.elements['trans-acc']?.focus(); } }
async function editTransaction(id) { const result = await callPython('get_transaction_details', String(id)); if (result?.success && result.data?.transaction) { const tran = result.data.transaction; await ensureInitialData(); populateAccountDropdowns('edit-trans-acc'); populateCategoryDropdowns('edit-trans-cat'); document.getElementById('edit-trans-id').value = tran.id; document.getElementById('edit-trans-acc').value = tran.account_id; document.getElementById('edit-trans-date').value = tran.date; document.getElementById('edit-trans-desc').value = tran.description; document.getElementById('edit-trans-cat').value = tran.category_id || ''; const amountValue = parseFloat(tran.amount); const isExpense = amountValue < 0; const typeSelect = document.getElementById('edit-trans-type'); if (typeSelect) { typeSelect.value = isExpense ? 'expense' : 'income'; } const amountInput = document.getElementById('edit-trans-amount'); if (amountInput) { amountInput.value = Math.abs(amountValue).toFixed(2); } openModal('edit-transaction-modal'); } else { showToast(result?.error || "Could not fetch transaction details.", 'error'); } }
async function handleEditTransaction(event) { event.preventDefault(); const form = event.target; const id = form.elements['edit-trans-id']?.value; const accountId = form.elements['edit-trans-acc']?.value; const date = form.elements['edit-trans-date']?.value; const descriptionInput = form.elements['edit-trans-desc']; const typeSelect = form.elements['edit-trans-type']; const transactionType = typeSelect?.value; const amountInput = form.elements['edit-trans-amount']; const categoryId = form.elements['edit-trans-cat']?.value || null; const description = descriptionInput?.value.trim(); let amountStr = amountInput?.value.trim().replace(',', '.'); if (!amountStr || !/^\d*\.?\d{0,2}$/.test(amountStr) || parseFloat(amountStr) < 0) { showToast("Invalid amount format. Enter a positive number.", 'warning'); amountInput?.focus(); return; } const amountToSend = (transactionType === 'expense') ? `-${amountStr}` : amountStr; if (!id) { console.error("Edit transaction ID missing!"); return; } if (!accountId) { showToast("Please select an account.", 'warning'); form.elements['edit-trans-acc']?.focus(); return; } if (!date) { showToast("Please select a date.", 'warning'); form.elements['edit-trans-date']?.focus(); return; } if (!description) { showToast("Description cannot be empty.", 'warning'); descriptionInput?.focus(); return; } if (!transactionType) { showToast("Please select a transaction type.", 'warning'); typeSelect?.focus(); return; } const result = await callPython('update_transaction', String(id), String(accountId), date, description, amountToSend, categoryId ? String(categoryId) : null ); if (result?.success) { showToast('Transaction updated.', 'success'); closeModal('edit-transaction-modal'); const currentFilter = document.getElementById('account-filter')?.value; if (currentView === 'transactions') await loadTransactionsData(currentFilter === 'null' ? null : currentFilter); if (currentView === 'dashboard') await loadDashboardData(); if (currentView === 'budget') await loadBudgetData(); await loadAccountsData(); } else { form.elements['edit-trans-acc']?.focus(); } }
async function deleteTransaction(id) { if (confirm(`Are you sure you want to delete this transaction?\nThis cannot be undone.`)) { const result = await callPython('delete_transaction', String(id)); if (result?.success) { showToast('Transaction deleted.', 'success'); const currentFilter = document.getElementById('account-filter')?.value; if (currentView === 'transactions') await loadTransactionsData(currentFilter === 'null' ? null : currentFilter); if (currentView === 'dashboard') await loadDashboardData(); if (currentView === 'budget') await loadBudgetData(); await loadAccountsData(); } } }
async function handleAddCategory(event) { event.preventDefault(); const form = event.target; const nameInput = form.elements['cat-name']; const typeSelect = form.elements['cat-type']; const name = nameInput?.value.trim(); const category_type = typeSelect?.value; if (!name) { showToast("Category name cannot be empty.", 'warning'); nameInput?.focus(); return; } if (name.toLowerCase() === 'uncategorized') { showToast("Cannot add 'Uncategorized'.", 'warning'); nameInput?.focus(); return; } if (!category_type) { showToast("Please select a category type.", 'warning'); typeSelect?.focus(); return; } const result = await callPython('add_category', name, category_type); if (result?.success) { showToast(`Category '${name}' added.`, 'success'); closeModal('add-category-modal'); form.reset(); await loadCategoriesData(); if (currentView === 'budget') await loadBudgetData(); await ensureInitialData(true); } else { nameInput?.focus(); } }
function editCategory(id, currentName, currentType) { if (currentName.toLowerCase() === 'uncategorized') { showToast("Cannot edit 'Uncategorized'.", 'warning'); return; } document.getElementById('edit-cat-id').value = id; document.getElementById('edit-cat-name').value = currentName; document.getElementById('edit-cat-type').value = currentType; openModal('edit-category-modal'); }
async function handleEditCategory(event) { event.preventDefault(); const form = event.target; const idInput = form.elements['edit-cat-id']; const nameInput = form.elements['edit-cat-name']; const typeSelect = form.elements['edit-cat-type']; const id = idInput?.value; const name = nameInput?.value.trim(); const category_type = typeSelect?.value; if (!id) { console.error("Edit category ID missing!"); return; } if (!name) { showToast("Category name cannot be empty.", 'warning'); nameInput?.focus(); return; } if (name.toLowerCase() === 'uncategorized') { showToast("Cannot rename to 'Uncategorized'.", 'warning'); nameInput?.focus(); return; } if (!category_type) { showToast("Please select a category type.", 'warning'); typeSelect?.focus(); return; } const result = await callPython('update_category', String(id), name, category_type); if (result?.success) { showToast(`Category '${name}' updated.`, 'success'); closeModal('edit-category-modal'); form.reset(); await loadCategoriesData(); if (currentView === 'budget') await loadBudgetData(); if (currentView === 'transactions') await loadTransactionsData(document.getElementById('account-filter')?.value === 'null' ? null : document.getElementById('account-filter')?.value); await ensureInitialData(true); } else { nameInput?.focus(); } }
async function deleteCategory(id, name) { if (name.toLowerCase() === 'uncategorized') { showToast("Cannot delete 'Uncategorized'.", 'warning'); return; } if (confirm(`Delete category "${escapeJsString(name)}"? Transactions will become 'Uncategorized'. Budgets will be deleted.`)) { const result = await callPython('delete_category', String(id)); if (result?.success) { showToast(`Category '${name}' deleted.`, 'success'); await loadCategoriesData(); if (currentView === 'budget') await loadBudgetData(); if (currentView === 'transactions') await loadTransactionsData(document.getElementById('account-filter')?.value === 'null' ? null : document.getElementById('account-filter')?.value); await ensureInitialData(true); } } }
const debouncedBudgetUpdate = debounce(async (categoryId, newAmountStr, month) => { const sanitizedAmount = newAmountStr.trim().replace(',', '.'); if (sanitizedAmount !== '' && !/^\d*\.?\d{0,2}$/.test(sanitizedAmount)) { showToast("Invalid budget amount format.", 'warning'); await loadBudgetData(); return; } const amountToSend = sanitizedAmount === '' ? '0.00' : sanitizedAmount; const result = await callPython('set_budget_amount', String(categoryId), month, amountToSend); if (!result?.success) { showToast('Failed to update budget. Reverting.', 'error'); } await loadBudgetData(); }, 800);
function handleBudgetInputChange(event) { const inputElement = event.target; if (inputElement.classList.contains('budget-input') && event.type === 'change') { const categoryId = inputElement.dataset.categoryId; const newAmount = inputElement.value; const monthInput = document.getElementById('budget-month'); const currentMonth = monthInput?.value; if (!currentMonth) { showToast("Month not selected.", 'warning'); return; } if (!categoryId) { console.error("Missing category ID on budget input:", inputElement); return; } debouncedBudgetUpdate(categoryId, newAmount, currentMonth); } }
async function handleRunReport() { const startDateInput = document.getElementById('report-start-date'); const endDateInput = document.getElementById('report-end-date'); const chartContainer = document.getElementById('spending-chart-container'); const placeholder = document.getElementById('report-placeholder'); const canvas = document.getElementById('spending-pie-chart'); if (!startDateInput || !endDateInput || !chartContainer || !placeholder || !canvas) { console.error("Report UI elements missing."); return; } const startDate = startDateInput.value; const endDate = endDateInput.value; if (!startDate || !endDate) { showToast("Please select both start and end dates.", "warning"); return; } if (new Date(startDate) > new Date(endDate)) { showToast("Start date cannot be after end date.", "warning"); return; } if (spendingChart) { spendingChart.destroy(); spendingChart = null; } canvas.style.display = 'none'; placeholder.style.display = 'block'; placeholder.className = 'placeholder-text loading'; placeholder.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Generating report...'; const result = await callPython('get_spending_by_category_report', startDate, endDate); if (result?.success && result.data?.report_data) { const reportData = result.data.report_data; if (reportData.length > 0) { placeholder.style.display = 'none'; canvas.style.display = 'block'; createSpendingChart(reportData); } else { placeholder.className = 'placeholder-text empty'; placeholder.innerHTML = '<span class="material-symbols-outlined">sentiment_dissatisfied</span> No spending data found.'; canvas.style.display = 'none'; } } else { placeholder.className = 'placeholder-text error'; placeholder.innerHTML = `<span class="material-symbols-outlined">error_outline</span> ${result?.error || 'Failed to generate report.'}`; canvas.style.display = 'none'; } }
function createSpendingChart(data) { if (typeof Chart === 'undefined') { console.error("Chart.js library is not loaded!"); showToast("Error: Chart library not available.", "error"); return; } const canvas = document.getElementById('spending-pie-chart'); if (!canvas) { console.error("Spending chart canvas not found!"); return; } const ctx = canvas.getContext('2d'); if (!ctx) { console.error("Failed to get 2D context"); return; } if (spendingChart) { spendingChart.destroy(); } const labels = data.map(item => item.category_name); const amounts = data.map(item => parseFloat(item.spent_amount)); const bgColors = generateChartColors(data.length); const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(); const borderColor = document.documentElement.classList.contains('dark-theme') ? '#2D3748' : '#FFFFFF'; try { spendingChart = new Chart(ctx, { type: 'pie', data: { labels: labels, datasets: [{ label: 'Spent Amount', data: amounts, backgroundColor: bgColors, borderColor: borderColor, borderWidth: 1.5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 20, boxWidth: 12, font: { size: 11 }, color: textColor } }, title: { display: false }, tooltip: { callbacks: { label: function(context) { let label = context.label || ''; if (label) label += ': '; label += formatCurrency(context.parsed); return label; } }, backgroundColor: 'rgba(0, 0, 0, 0.7)', titleFont: { size: 14 }, bodyFont: { size: 12 }, padding: 10, bodyColor: '#ffffff', titleColor: '#ffffff' } } } }); } catch (chartError) { console.error("Error creating chart:", chartError); showToast("Error occurred while displaying the chart.", "error"); } }

// --- Utility Functions ---
function generateChartColors(count) { const colors = []; const saturation = 70; const lightness = document.documentElement.classList.contains('dark-theme') ? 60 : 55; const hueStep = count > 1 ? 360 / count : 0; const startHue = 30; for (let i = 0; i < count; i++) { const hue = (startHue + i * hueStep) % 360; colors.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`); } return colors; }
function formatCurrency(value) { const num = parseFloat(String(value ?? '0').replace(/[$,]/g, '')); if (isNaN(num)) return "$0.00"; return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num); }
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
function escapeJsString(unsafe) { if (unsafe === null || unsafe === undefined) return ''; return String(unsafe) .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"') .replace(/\n/g, '\\n').replace(/\r/g, '\\r'); }
function populateAccountDropdowns(targetSelectId = null) { const selectorIds = targetSelectId ? [targetSelectId] : ['account-filter', 'trans-acc', 'edit-trans-acc']; selectorIds.forEach(selectId => { const selectElement = document.getElementById(selectId); if (!selectElement) return; const currentValue = selectElement.value; const isDisabled = selectElement.disabled; selectElement.innerHTML = ''; if (selectId === 'account-filter') { selectElement.add(new Option("All Accounts", "null")); } if (accountsData && accountsData.length > 0) { const sortedAccounts = [...accountsData].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); sortedAccounts.forEach(acc => { selectElement.add(new Option(escapeHtml(acc.name), acc.id)); }); selectElement.disabled = isDisabled; } else { if (selectId !== 'account-filter') { const noAccOption = new Option("No accounts available", ""); noAccOption.disabled = true; selectElement.add(noAccOption); selectElement.disabled = true; } else { selectElement.disabled = false; } } selectElement.value = Array.from(selectElement.options).some(opt => opt.value === currentValue) ? currentValue : (selectId === 'account-filter' ? 'null' : ''); if (!isDisabled && selectElement.options.length > (selectId === 'account-filter' ? 1 : 0)) { selectElement.disabled = false; } }); }
function populateCategoryDropdowns(targetSelectId = null) { const selectorIds = targetSelectId ? [targetSelectId] : ['trans-cat', 'edit-trans-cat']; selectorIds.forEach(selectId => { const selectElement = document.getElementById(selectId); if (!selectElement) return; const currentValue = selectElement.value; selectElement.innerHTML = '<option value="">Uncategorized</option>'; const isDisabled = selectElement.disabled; if (categoryData && categoryData.length > 0) { const sortedCategories = [...categoryData] .filter(cat => cat.name.toLowerCase() !== 'uncategorized') .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); sortedCategories.forEach(cat => { selectElement.add(new Option(escapeHtml(cat.name), cat.id)); }); selectElement.disabled = isDisabled; } else { selectElement.disabled = isDisabled; } selectElement.value = Array.from(selectElement.options).some(opt => opt.value === currentValue) ? currentValue : ""; if (!isDisabled) { selectElement.disabled = false; } }); }


// --- Event Listeners Setup ---
function setupEventListeners() {
    console.log("Setting up event listeners...");
    // Navigation
    document.querySelector('.nav-list')?.addEventListener('click', (event) => { const button = event.target.closest('.nav-button'); if (button && !button.disabled && button.dataset.view) { switchView(button.dataset.view); } });
    document.querySelector('.sidebar-bottom')?.addEventListener('click', (event) => { const button = event.target.closest('.nav-button'); if (button && !button.disabled && button.dataset.view) { switchView(button.dataset.view); } });
    // Modal Open Buttons
    document.getElementById('add-account-btn')?.addEventListener('click', () => openModal('add-account-modal'));
    document.getElementById('add-transaction-btn')?.addEventListener('click', () => openModal('add-transaction-modal'));
    document.getElementById('add-category-btn')?.addEventListener('click', () => openModal('add-category-modal'));
    // Form Submissions
    document.addEventListener('submit', (event) => { const form = event.target; switch (form.id) { case 'add-account-form': handleAddAccount(event); break; case 'edit-account-form': handleEditAccount(event); break; case 'add-transaction-form': handleAddTransaction(event); break; case 'edit-transaction-form': handleEditTransaction(event); break; case 'add-category-form': handleAddCategory(event); break; case 'edit-category-form': handleEditCategory(event); break; } });
    // Filters and View Controls
    document.getElementById('account-filter')?.addEventListener('change', (event) => { const selectedAccountId = event.target.value === 'null' ? null : event.target.value; loadTransactionsData(selectedAccountId); });
    document.getElementById('budget-month')?.addEventListener('change', loadBudgetData);
    document.getElementById('run-report-btn')?.addEventListener('click', handleRunReport);
    // Settings View Listeners
    document.getElementById('export-xlsx-btn')?.addEventListener('click', handleExportExcel);
    themeToggle = document.getElementById('theme-toggle'); // Assign here
    if (themeToggle) { themeToggle.addEventListener('change', handleThemeToggle); console.log("Theme toggle listener attached."); } else { console.error("Could not find theme toggle element to attach listener."); }
    // Placeholder buttons
    document.getElementById('backup-db-btn')?.addEventListener('click', () => { showToast('Database backup feature not implemented yet.', 'info'); });
    document.getElementById('restore-db-btn')?.addEventListener('click', () => { showToast('Database restore feature not implemented yet. Be careful!', 'warning'); });
    // Budget Table Input Changes
    document.getElementById('budget-table-body')?.addEventListener('change', handleBudgetInputChange);
    // Modal Close Mechanisms
    document.addEventListener('click', (event) => { const closeButton = event.target.closest('.close-button'); if (closeButton) { const modal = closeButton.closest('.modal'); if (modal) closeModal(modal.id); return; } if (event.target.classList.contains('modal') && event.target.classList.contains('active')) { closeModal(event.target.id); } if (event.target.matches('.modal .form-actions .button.secondary')) { const modal = event.target.closest('.modal'); if (modal) closeModal(modal.id); } });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const activeModal = document.querySelector('.modal.active'); if (activeModal) closeModal(activeModal.id); } });
    console.log("Event listeners set up.");
}

// --- Initial Data Loading Strategy ---
let initialDataLoadPromise = null;
let isLoadingInitialData = false;
async function ensureInitialData(forceRefresh = false) {
    // Simplified: Always wait for API and load if cache is empty or forced
    if (isLoadingInitialData && !forceRefresh) { return initialDataLoadPromise; } // Wait for ongoing

    if ((accountsData.length === 0 || categoryData.length === 0) || forceRefresh) {
        isLoadingInitialData = true;
        initialDataLoadPromise = (async () => {
            try {
                const isReady = await waitForPywebview(); // Ensure pywebview is fully ready
                if (!isReady) { throw new Error("Pywebview API failed to initialize."); }
                console.log("ensureInitialData: API ready, fetching data...");

                // Fetch only if data is missing or forced
                if (accountsData.length === 0 || categoryData.length === 0 || forceRefresh) {
                    const results = await Promise.all([ callPython('get_accounts'), callPython('get_categories') ]);
                    const accountResult = results[0]; const categoryResult = results[1];
                    if (accountResult?.success && accountResult.data?.accounts) { accountsData = accountResult.data.accounts; } else { console.error("Failed to load initial accounts:", accountResult?.error); accountsData = []; /* Toast handled by callPython */ }
                    if (categoryResult?.success && categoryResult.data?.categories) { categoryData = categoryResult.data.categories; } else { console.error("Failed to load initial categories:", categoryResult?.error); categoryData = []; /* Toast handled by callPython */ }
                    populateAccountDropdowns(); populateCategoryDropdowns();
                    console.log("ensureInitialData: Data fetch/population complete.");
                } else { console.log("ensureInitialData: Using cached data."); }
            } catch (err) {
                console.error("Critical error during initial data load/API check:", err);
                if (!err.message.includes("Pywebview API failed")) { showToast("Failed to load essential application data.", 'error'); }
                accountsData = []; categoryData = []; populateAccountDropdowns(); populateCategoryDropdowns();
                throw err; // Propagate error
            } finally { isLoadingInitialData = false; }
        })();
        return initialDataLoadPromise;
    } else {
        console.log("ensureInitialData: Skipped fetch (API ready & data cached).");
        // Still need to ensure API is ready even if data is cached
        const isReady = await waitForPywebview();
        if (!isReady) throw new Error("Pywebview API failed to initialize even with cached data.");
        return Promise.resolve(); // API ready and data cached
    }
}


// --- Export Function ---
async function handleExportExcel() {
    const filenameInput = document.getElementById('export-filename');
    const currentDate = new Date().toLocaleDateString('en-CA');
    const baseFilename = filenameInput?.value.trim() || `FinancXpert_Export_${currentDate}`;
    if (!baseFilename) { showToast('Please enter a base filename.', 'warning'); filenameInput?.focus(); return; }
    if (/[\\/:*?"<>|]/.test(baseFilename)) { showToast('Filename contains invalid characters: \\ / : * ? " < > |', 'warning'); filenameInput?.focus(); return; }
    showToast('Generating export...', 'info');
    const result = await callPython('export_data_to_excel', baseFilename);
    if (result?.success) { showToast(result.data?.message || 'Export completed!', 'success'); if(filenameInput) filenameInput.value = ''; }
    else { if (!result?.error) { showToast('Export failed. Check logs.', 'error'); } } // Error toast shown by callPython
}

async function initializeApp() {
    console.log("DOM Loaded. Initializing App...");

    // Assign themeToggle global variable (important for event listener setup)
    themeToggle = document.getElementById('theme-toggle');
    if (!themeToggle) { console.warn("initializeApp: Theme toggle element not found!"); }

    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) loadingIndicator.style.display = 'flex';

    // Setup listeners early (includes theme toggle listener)
    setupEventListeners();

    let initialTheme = 'light'; // Assume light initially

    try {
        // Step 1: Wait for pywebview API to be ready
        const isReady = await waitForPywebview(); // Use the robust check
        if (!isReady) { throw new Error("Pywebview API failed to initialize."); }
        console.log("initializeApp: API ready.");

        // Step 2: Fetch theme preference from DB via API
        const themeResult = await callPython('get_theme_preference');
        if (themeResult?.success && themeResult.data?.theme) {
            initialTheme = themeResult.data.theme;
            console.log(`initializeApp: Got theme '${initialTheme}' from backend.`);
        } else {
            console.warn("initializeApp: Could not get theme from backend, defaulting to light.", themeResult?.error);
            initialTheme = 'light';
            if (themeResult && !themeResult.success && themeResult.error) { showToast("Could not load saved theme preference.", "warning"); }
        }

        // Step 3: Apply the determined theme AND set toggle state visually
        applyThemeAndToggle(initialTheme);

        // Step 4: Load initial account/category data (API is confirmed ready)
        await ensureInitialData();
        console.log("initializeApp: ensureInitialData completed.");

        // Step 5: Set other defaults
        const monthInput = document.getElementById('budget-month');
        if (monthInput && !monthInput.value) { monthInput.value = new Date().toISOString().slice(0, 7); }

        // Step 6: Switch to initial view
        switchView('dashboard'); // Triggers loadDashboardData

    } catch (error) {
        // Catches errors from waitForPywebview, get_theme_preference, ensureInitialData
        console.error("Initialization failed:", error);
        applyThemeAndToggle('light'); 
        switchView('dashboard'); // Attempt to show dashboard
    } finally {
        // Hide loading indicator AFTER setup attempt
        if (loadingIndicator) { loadingIndicator.style.display = 'none'; console.log("Loading indicator hidden."); }
    }
    console.log("App Initialization sequence finished.");
}
// --- Global Event Listeners ---
document.addEventListener('DOMContentLoaded', initializeApp);
window.addEventListener('pywebviewready', () => { console.log('Event: pywebviewready received.'); });