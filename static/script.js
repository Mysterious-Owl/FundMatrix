let dashboardData = null;
let currentSort = { column: 'current_val', order: 'desc' };
let hideZero = true;
let selectedCategories = [];
let selectedActivities = [];
let selectedAMCs = [];
let selectedSectors = [];
let selectedCaps = [];

const CHART_FILTER_TYPES = {
    'catChart': 'category', 'catXirrChart': 'category',
    'amcChart': 'amc', 'amcXirrChart': 'amc',
    'sectorChart': 'sector', 'sectorXirrChart': 'sector',
    'capChart': 'cap', 'capXirrChart': 'cap'
};
let activeModalChartId = null;
let activeModalTitle = null;
let searchQuery = "";
let collapsedBuckets = new Set();
let currentRollingSort = { column: 'mean', order: 'desc' };
let currentGrowthRange = 'ALL';
let currentTrendRange = 'ALL';

// Register Plugin and Globally Disable by Default
if (typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
    Chart.defaults.set('plugins.datalabels', {
        display: false
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/data');
        dashboardData = await response.json();
        if (dashboardData.error) { console.error(dashboardData.error); return; }
        initializeDashboard();
        loadConfig();
    } catch (error) { console.error('Failed to load dashboard data:', error); }
});

// --- XIRR SOLVER (JS) ---
// Newton-Raphson method for XIRR
function calculateJS_XIRR(cashFlows) {
    if (cashFlows.length < 2) return 0;

    // Sort flows by date to ensure the first one is the earliest
    cashFlows.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Convert dates to fractional years since first date
    const firstDate = new Date(cashFlows[0].date);
    const flows = cashFlows.map(cf => ({
        t: (new Date(cf.date) - firstDate) / (365.25 * 24 * 60 * 60 * 1000),
        v: cf.amount
    }));

    let rate = 0.1; // Initial guess 10%
    for (let i = 0; i < 20; i++) {
        let f = 0;
        let df = 0;
        for (const flow of flows) {
            const denom = Math.pow(1 + rate, flow.t);
            f += flow.v / denom;
            df -= (flow.t * flow.v) / (denom * (1 + rate));
        }
        if (Math.abs(f) < 1e-6) break;
        const nextRate = rate - f / df;
        if (isNaN(nextRate) || !isFinite(nextRate)) break;
        rate = nextRate;
    }
    return rate * 100;
}

// --- FORMATTERS & HELPERS ---
function fmtSmartValue(v) {
    const abs = Math.abs(v);
    if (abs >= 100000) return (v / 100000).toFixed(1) + 'L';
    if (abs >= 1000) return (v / 1000).toFixed(0) + 'k';
    return v.toFixed(0);
}

function getSmartScale(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return { min: 0, max: 100 };
    const minVal = Math.min(...dataPoints);
    const maxVal = Math.max(...dataPoints);

    let yMin = minVal - Math.abs(minVal) * 0.05;
    let yMax = maxVal + Math.abs(maxVal) * 0.05;

    // Rule: minimum can be 0 only if -5% of min is less than 0
    if (yMin < 0 && minVal >= 0) yMin = 0;

    return { min: yMin, max: yMax };
}

// NAVIGATION LOGIC
// NAVIGATION LOGIC
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const body = document.body;
    if (!sidebar) return;

    sidebar.classList.toggle('active');
    body.classList.toggle('sidebar-expanded');

    const icon = document.getElementById('lock-icon');
    const text = document.querySelector('#lock-btn .nav-text');
    if (sidebar.classList.contains('active')) {
        if (icon) icon.className = 'fas fa-angle-double-left';
        if (text) text.textContent = 'Collapse';
    } else {
        if (icon) icon.className = 'fas fa-angle-double-right';
        if (text) text.textContent = 'Expand';
    }
}

function toggleFilterSidebar() {
    const sidebar = document.getElementById('filter-sidebar');
    const overlay = document.getElementById('filter-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.toggle('active');
    overlay.classList.toggle('active');
}

function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        if (document.getElementById('sidebar').classList.contains('active')) toggleSidebar();
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelectorAll('.side-tab-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick').includes(`'${sectionId}'`)) btn.classList.add('active');
        });
    }
}

window.addEventListener('scroll', () => {
    const sections = ['overview', 'gains', 'investments', 'allocations', 'xirr', 'rolling', 'comparison', 'management'];
    let current = "";
    sections.forEach(s => {
        const el = document.getElementById(s);
        if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top <= 150) current = s;
        }
    });
    if (current) {
        document.querySelectorAll('.side-tab-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick').includes(`'${current}'`)) btn.classList.add('active');
        });
    }
});

// MULTI-SELECT LOGIC
function toggleMultiselect(id) {
    document.getElementById(id).classList.toggle('active');
}

function updateSelectedFilterLabels() {
    const filters = [
        { list: selectedCategories, labelId: 'selected-cats-label', default: 'All Categories', suffix: 'Categories' },
        { list: selectedAMCs, labelId: 'selected-amc-label', default: 'All AMCs', suffix: 'AMCs' },
        { list: selectedSectors, labelId: 'selected-sector-label', default: 'All Sectors', suffix: 'Sectors' },
        { list: selectedCaps, labelId: 'selected-cap-label', default: 'All Caps', suffix: 'Caps' },
        { list: selectedActivities, labelId: 'selected-activity-label', default: 'All Activity', suffix: 'Activity Types' }
    ];
    filters.forEach(f => {
        const el = document.getElementById(f.labelId);
        if (!el) return;
        if (f.list.length === 0) el.textContent = f.default;
        else if (f.list.length === 1) el.textContent = f.list[0];
        else el.textContent = `${f.list.length} ${f.suffix} Selected`;
    });
}

function initializeDashboard() {
    // Populate Categories
    const catContainer = document.getElementById('cat-options');
    catContainer.innerHTML = dashboardData.categories.map(cat => `
        <div class="option" onclick="toggleFilter('category', '${cat}', event)">
            <input type="checkbox" id="check-category-${cat}" ${selectedCategories.includes(cat) ? 'checked' : ''}>
            <label>${cat}</label>
        </div>
    `).join('');

    // Populate AMCs
    const amcContainer = document.getElementById('amc-options');
    if (amcContainer && dashboardData.amcs && dashboardData.amcs.length) {
        amcContainer.innerHTML = dashboardData.amcs.map(amc => `
            <div class="option" onclick="toggleFilter('amc', '${amc}', event)">
                <input type="checkbox" id="check-amc-${amc}" ${selectedAMCs.includes(amc) ? 'checked' : ''}>
                <label>${amc}</label>
            </div>
        `).join('');
    }

    // Populate Sectors
    const sectorContainer = document.getElementById('sector-options');
    if (sectorContainer && dashboardData.sectors && dashboardData.sectors.length) {
        sectorContainer.innerHTML = dashboardData.sectors.map(s => `
            <div class="option" onclick="toggleFilter('sector', '${s}', event)">
                <input type="checkbox" id="check-sector-${s}" ${selectedSectors.includes(s) ? 'checked' : ''}>
                <label>${s}</label>
            </div>
        `).join('');
    }

    // Populate Caps
    const capContainer = document.getElementById('cap-options');
    if (capContainer && dashboardData.caps && dashboardData.caps.length) {
        capContainer.innerHTML = dashboardData.caps.map(c => `
            <div class="option" onclick="toggleFilter('cap', '${c}', event)">
                <input type="checkbox" id="check-cap-${c}" ${selectedCaps.includes(c) ? 'checked' : ''}>
                <label>${c}</label>
            </div>
        `).join('');
    }

    // Populate Activity States
    const activityContainer = document.getElementById('activity-options');
    activityContainer.innerHTML = dashboardData.activity_states.map(state => `
        <div class="option" onclick="toggleFilter('activity', '${state}', event)">
            <input type="checkbox" id="check-activity-${state}" ${selectedActivities.includes(state) ? 'checked' : ''}>
            <label>${state}</label>
        </div>
    `).join('');

    const bucketLabels = ['Inside 7 Days', '8 - 14 Days', '15 - 30 Days', '1 - 2 Months', '2 - 3 Months'];
    bucketLabels.forEach(label => collapsedBuckets.add(label));

    refreshAll();
    document.getElementById('last-updated').textContent = `Sync: ${dashboardData.last_updated}`;
}

function toggleFilter(type, value, event) {
    if (event) event.stopPropagation();
    const map = {
        'category': selectedCategories,
        'activity': selectedActivities,
        'amc': selectedAMCs,
        'sector': selectedSectors,
        'cap': selectedCaps
    };
    let list = map[type];
    const idx = list.indexOf(value);
    if (idx > -1) list.splice(idx, 1);
    else list.push(value);

    const checkbox = document.getElementById(`check-${type}-${value}`);
    if (checkbox) checkbox.checked = !checkbox.checked;

    updateSelectedFilterLabels();
    refreshAll();
}

function clearAllFilters() {
    selectedCategories = [];
    selectedActivities = [];
    selectedAMCs = [];
    selectedSectors = [];
    selectedCaps = [];

    // Uncheck all checkboxes
    document.querySelectorAll('.options-container input[type="checkbox"]').forEach(cb => cb.checked = false);

    updateSelectedFilterLabels();
    refreshAll();
}

window.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-multiselect')) {
        document.querySelectorAll('.options-container').forEach(el => el.classList.remove('active'));
    }
});

function refreshAll() {
    renderOverview();
    renderGains();
    renderInvestments();
    renderAllocations();
    renderTransitionTable();
    renderRollingStats();
    renderComparison();
    renderStats();
    if (activeModalChartId) renderModalChart();
}

function toggleZeroHoldings() {
    hideZero = !hideZero;
    const btn = document.getElementById('hide-zero-btn');
    if (hideZero) {
        btn.classList.add('active');
        btn.querySelector('span').textContent = "Hide Zero";
        btn.querySelector('i').className = "fas fa-eye-slash";
    } else {
        btn.classList.remove('active');
        btn.querySelector('span').textContent = "Show All";
        btn.querySelector('i').className = "fas fa-eye";
    }
    refreshAll();
}

function filterTable() {
    searchQuery = document.getElementById('scheme-search').value.toLowerCase();
    renderGains();
}

function sortData(col) {
    if (currentSort.column === col) currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
    else { currentSort.column = col; currentSort.order = 'desc'; }
    renderGains();
}

function getFilteredData() {
    let filtered = dashboardData.scheme_details;
    if (selectedCategories.length > 0) filtered = filtered.filter(s => selectedCategories.includes(s.Category));
    if (selectedActivities.length > 0) filtered = filtered.filter(s => selectedActivities.includes(s.ActivityState));
    if (selectedAMCs.length > 0) filtered = filtered.filter(s => selectedAMCs.includes(s.AMC));
    if (selectedSectors.length > 0) filtered = filtered.filter(s => selectedSectors.includes(s.Sector));
    if (selectedCaps.length > 0) filtered = filtered.filter(s => selectedCaps.includes(s.Cap));
    if (hideZero) filtered = filtered.filter(s => s.current_val > 0);
    return filtered;
}

function getFilteredCashFlows() {
    let filtered = dashboardData.cash_flows;
    // Activity filtering for cash flows is complex, but we can filter by the schemes that are active in the filtered list
    const activeISINs = new Set(getFilteredData().map(s => s.ISIN));
    filtered = filtered.filter(cf => activeISINs.has(cf.isin));
    return filtered;
}

function filterDataByRange(data, range, dateField = 'date') {
    if (range === 'ALL' || !data || data.length === 0) return data;
    const now = new Date();
    const rangeMap = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 };
    const months = rangeMap[range];
    const cutoff = new Date();
    cutoff.setMonth(now.getMonth() - months);
    return data.filter(d => new Date(d[dateField]) >= cutoff);
}

function updateGrowthRange(range) {
    currentGrowthRange = range;
    document.querySelectorAll('#growth-range-filters .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === range || (range === 'ALL' && btn.textContent === 'All'));
    });
    renderOverview();
}

function updateTrendRange(range) {
    currentTrendRange = range;
    document.querySelectorAll('#trend-range-filters .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === range || (range === 'ALL' && btn.textContent === 'All'));
    });
    renderInvestments();
}

function expandChart(chartId, title) {
    activeModalChartId = chartId;
    activeModalTitle = title;
    const originalChart = Chart.getChart(chartId);
    if (!originalChart) return;

    document.getElementById('modal-chart-title').textContent = title;
    const modal = document.getElementById('chart-modal');
    modal.classList.add('active');

    // Populate Modal Range Filters if it's a line chart
    const filterContainer = document.getElementById('modal-range-filters');
    filterContainer.innerHTML = '';
    if (chartId === 'growthChart' || chartId === 'investmentTrendChart') {
        const currentRange = (chartId === 'growthChart') ? currentGrowthRange : currentTrendRange;
        const ranges = ['1M', '6M', '1Y', 'ALL'];
        ranges.forEach(r => {
            const btn = document.createElement('button');
            btn.className = `pill-btn ${r === currentRange ? 'active' : ''}`;
            btn.textContent = r === 'ALL' ? 'All' : r;
            btn.onclick = () => updateModalRange(r);
            filterContainer.appendChild(btn);
        });
    }

    renderModalChart();
}

function renderModalChart() {
    if (!activeModalChartId) return;
    const originalChart = Chart.getChart(activeModalChartId);
    if (!originalChart) return;

    const modalCtx = document.getElementById('modalChart').getContext('2d');
    const existing = Chart.getChart('modalChart');
    if (existing) existing.destroy();

    // Reconstruct chart for modal with optimizations for speed
    new Chart(modalCtx, {
        type: originalChart.config.type,
        data: originalChart.data,
        options: {
            ...originalChart.options,
            maintainAspectRatio: false,
            animation: { duration: 0 }, // Disable animation for instant modal feel
            plugins: {
                ...originalChart.options.plugins,
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: '#cbd5e1', font: { size: 12 } }
                }
            }
        }
    });
}

function updateModalRange(range) {
    if (activeModalChartId === 'growthChart') {
        updateGrowthRange(range);
    } else if (activeModalChartId === 'investmentTrendChart') {
        updateTrendRange(range);
    }

    // Refresh modal filters UI
    document.querySelectorAll('#modal-range-filters .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent === range || (range === 'ALL' && btn.textContent === 'All'));
    });

    // Re-render modal chart with newly filtered data from global refresh
    renderModalChart();
}

function closeModal() {
    activeModalChartId = null;
    activeModalTitle = null;
    document.getElementById('chart-modal').classList.remove('active');
}

function renderOverview() {
    const filteredSchemes = getFilteredData();
    const s = {
        current: filteredSchemes.reduce((a, b) => a + b.current_val, 0),
        invested: filteredSchemes.reduce((a, b) => a + b.invested_val, 0),
        realized: filteredSchemes.reduce((a, b) => a + (b.realized_stcg + b.realized_ltcg), 0),
        unrealized: filteredSchemes.reduce((a, b) => a + b.unrealized_gain, 0)
    };
    const totalProfit = s.unrealized + s.realized;
    document.getElementById('ov-current').textContent = fmtMoney(s.current);
    document.getElementById('ov-invested').textContent = `Cost: ${fmtMoney(s.invested)}`;
    document.getElementById('ov-unrealized').textContent = fmtMoney(s.unrealized);
    document.getElementById('ov-unrealized').className = `kpi-value ${s.unrealized >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('ov-realized').textContent = fmtMoney(s.realized);
    document.getElementById('ov-realized').className = `kpi-value ${s.realized >= 0 ? 'positive' : 'negative'}`;
    const elProfit = document.getElementById('ov-total-profit');
    elProfit.textContent = fmtMoney(totalProfit);
    elProfit.className = `kpi-value ${totalProfit >= 0 ? 'positive' : 'negative'}`;
    const absRet = s.invested > 0 ? (totalProfit / s.invested * 100).toFixed(2) : "0.00";
    document.getElementById('ov-abs-ret').textContent = `${absRet}% Absolute`;

    // DYNAMIC XIRR
    const filteredFlows = getFilteredCashFlows();
    const dynamicXirr = calculateJS_XIRR(filteredFlows);
    document.getElementById('ov-xirr').textContent = `${dynamicXirr.toFixed(2)}%`;

    // DYNAMIC GROWTH CHART (Responsive to Category/Filter)
    const activeISINs = new Set(filteredSchemes.map(s => s.ISIN));
    const aggregatedGrowth = dashboardData.growth_chart.map(dp => {
        let totalVal = 0;
        let totalInv = 0;
        Object.entries(dp.b).forEach(([isin, item]) => {
            if (activeISINs.has(isin)) {
                totalVal += item.v;
                totalInv += item.i;
            }
        });
        return { date: dp.date, value: totalVal, invested: totalInv };
    }).filter(d => d.value > 0 || d.invested > 0);

    const filteredGrowth = filterDataByRange(aggregatedGrowth, currentGrowthRange, 'date');

    const growthCtx = document.getElementById('growthChart').getContext('2d');
    const existingGrowth = Chart.getChart('growthChart');
    if (existingGrowth) existingGrowth.destroy();
    new Chart(growthCtx, {
        type: 'line', data: {
            labels: filteredGrowth.map(d => d.date),
            datasets: [
                { label: 'Market Value', data: filteredGrowth.map(d => d.value), borderColor: '#22d3ee', backgroundColor: 'rgba(34, 211, 238, 0.4)', fill: true, tension: 0.2, pointRadius: 0 },
                { label: 'Capital Invested', data: filteredGrowth.map(d => d.invested), borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.6)', fill: 0, tension: 0.1, pointRadius: 0, borderDash: [5, 5] }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.raw)}` } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 } } },
                y: {
                    ...getSmartScale([...filteredGrowth.map(d => d.value), ...filteredGrowth.map(d => d.invested)]),
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#64748b', callback: (v) => '₹' + fmtSmartValue(v) }
                }
            }
        }
    });
}

function renderGains() {
    const tableBody = document.getElementById('scheme-gain-body');
    if (!tableBody || !dashboardData.scheme_details) return;

    let filtered = getFilteredData();
    if (searchQuery) filtered = filtered.filter(s => s['Fund Name'].toLowerCase().includes(searchQuery));

    const col = currentSort.column;
    const order = currentSort.order === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
        if (a[col] < b[col]) return -order;
        if (a[col] > b[col]) return order;
        return 0;
    });

    tableBody.innerHTML = filtered.map(s => {
        // Calculate Scheme-Specific XIRR
        const schemeFlows = dashboardData.cash_flows.filter(cf => cf.isin === s.ISIN);
        const schemeXirr = calculateJS_XIRR(schemeFlows);

        return `
            <tr>
                <td style="font-weight:600; min-width: 250px;">${s['Fund Name']}</td>
                <td style="text-align:right">${fmtPrice(s.invested_val)}</td>
                <td style="text-align:right">${fmtPrice(s.current_val)}</td>
                <td style="text-align:right" class="${s.unrealized_stcg >= 0 ? 'positive' : 'negative'}">${fmtPrice(s.unrealized_stcg)}</td>
                <td style="text-align:right" class="${s.unrealized_ltcg >= 0 ? 'positive' : 'negative'}">${fmtPrice(s.unrealized_ltcg)}</td>
                <td style="text-align:right; font-weight:600" class="${s.total_profit >= 0 ? 'positive' : 'negative'}">${fmtPrice(s.total_profit)}</td>
                <td style="text-align:right; font-weight:700" class="${s.abs_return >= 0 ? 'positive' : 'negative'}">${s.abs_return.toFixed(3)}%</td>
                <td style="text-align:right; font-weight:700" class="${schemeXirr >= 0 ? 'positive' : 'negative'}">${schemeXirr.toFixed(2)}%</td>
                <td style="text-align:right; color: var(--text-muted); font-size: 0.85rem">${fmtPrice(s.lt_units)}</td>
                <td style="text-align:right; color: #4ade80; font-size: 0.85rem">${fmtPrice(s.unrealized_ltcg)}</td>
            </tr>
        `;
    }).join('');

    // Update taxation summary (remains same)
    const u_st = filtered.reduce((a, b) => a + b.unrealized_stcg, 0);
    const u_lt = filtered.reduce((a, b) => a + b.unrealized_ltcg, 0);
    const r_st = filtered.reduce((a, b) => a + b.realized_stcg, 0);
    const r_lt = filtered.reduce((a, b) => a + b.realized_ltcg, 0);
    if (document.getElementById('unrealized-stcg')) document.getElementById('unrealized-stcg').textContent = fmtMoney(u_st);
    if (document.getElementById('unrealized-ltcg')) document.getElementById('unrealized-ltcg').textContent = fmtMoney(u_lt);
    if (document.getElementById('unrealized-total')) document.getElementById('unrealized-total').textContent = fmtMoney(u_st + u_lt);
    if (document.getElementById('realized-stcg')) document.getElementById('realized-stcg').textContent = fmtMoney(r_st);
    if (document.getElementById('realized-ltcg')) document.getElementById('realized-ltcg').textContent = fmtMoney(r_lt);
    if (document.getElementById('realized-total')) document.getElementById('realized-total').textContent = fmtMoney(r_st + r_lt);
}

function toggleBucket(label) {
    if (collapsedBuckets.has(label)) collapsedBuckets.delete(label);
    else collapsedBuckets.add(label);
    renderTransitionTable();
}

function renderTransitionTable() {
    const tableBody = document.getElementById('transition-body');
    if (!tableBody || !dashboardData.transition_planning) return;

    // Use universal filtering based on the currently passing schemes
    const filteredISINs = new Set(getFilteredData().map(s => s.ISIN));
    let filtered = dashboardData.transition_planning.filter(p => filteredISINs.has(p.ISIN));
    const buckets = [{ label: 'Inside 7 Days', max: 7 }, { label: '8 - 14 Days', max: 14 }, { label: '15 - 30 Days', max: 30 }, { label: '1 - 2 Months', max: 60 }, { label: '2 - 3 Months', max: 90 }];
    const grouped = {};
    buckets.forEach(b => grouped[b.label] = { items: [], totalGain: 0 });
    filtered.forEach(p => {
        const bucket = buckets.find(b => p.days_left <= b.max);
        if (bucket) { grouped[bucket.label].items.push(p); grouped[bucket.label].totalGain += p.gain; }
    });
    let html = ""; let cumTotalGain = 0;
    buckets.forEach(b => {
        const group = grouped[b.label];
        if (group.items.length === 0) return;
        cumTotalGain += group.totalGain;
        const isCollapsed = collapsedBuckets.has(b.label);
        html += `<tr class="bucket-header" onclick="toggleBucket('${b.label}')"><td><i class="fas fa-chevron-${isCollapsed ? 'right' : 'down'}"></i> <strong>${b.label}</strong></td><td style="text-align:right" class="positive">₹${fmtPrice(group.totalGain)}</td><td style="text-align:right" class="highlight">₹${fmtPrice(cumTotalGain)}</td></tr>`;
        if (!isCollapsed) {
            group.items.forEach(p => {
                html += `<tr class="bucket-item"><td style="padding-left: 2rem; font-size: 0.8rem;">${p.scheme}</td><td style="text-align:right; font-size: 0.8rem;">${fmtPrice(p.gain)}</td><td style="text-align:right; opacity:0.5; font-size: 0.8rem;">-</td></tr>`;
            });
        }
    });
    tableBody.innerHTML = html;
}

const expandedYears = new Set(); // Global set to track expanded years

function toggleYear(year) {
    if (expandedYears.has(year)) expandedYears.delete(year);
    else expandedYears.add(year);
    renderInvestments();
}

function renderInvestments() {
    if (!dashboardData.investment_summary) return;
    const { pivot: allPivot, months: mKeys } = dashboardData.investment_summary;

    // A. FILTER DATA
    let filteredPivot = allPivot;
    if (selectedCategories.length > 0) filteredPivot = filteredPivot.filter(p => selectedCategories.includes(p.Category));
    if (selectedActivities.length > 0) filteredPivot = filteredPivot.filter(p => selectedActivities.includes(p.ActivityState));
    if (selectedAMCs.length > 0) filteredPivot = filteredPivot.filter(p => selectedAMCs.includes(p.AMC));
    if (selectedSectors.length > 0) filteredPivot = filteredPivot.filter(p => selectedSectors.includes(p.Sector));
    if (selectedCaps.length > 0) filteredPivot = filteredPivot.filter(p => selectedCaps.includes(p.Cap));

    if (hideZero) {
        const activeISINs = new Set(dashboardData.scheme_details.filter(s => s.current_val > 0).map(s => s.ISIN));
        filteredPivot = filteredPivot.filter(p => activeISINs.has(p.ISIN));
    }

    // B. RE-CALCULATE TOTALS FOR GRAPH BASED ON FILTERED DATA
    const totalsMap = {};
    mKeys.forEach(mk => totalsMap[mk] = 0);
    filteredPivot.forEach(p => totalsMap[p.DateKey] += p.Amount);

    const totalsData = mKeys.map((mk, idx) => {
        const amt = totalsMap[mk];
        // Calculate MA dynamically
        let sum3 = 0, count3 = 0;
        for (let i = Math.max(0, idx - 2); i <= idx; i++) { sum3 += totalsMap[mKeys[i]]; count3++; }
        let sum6 = 0, count6 = 0;
        for (let i = Math.max(0, idx - 5); i <= idx; i++) { sum6 += totalsMap[mKeys[i]]; count6++; }

        return {
            date: mKeys[idx], // Re-add date for filtering
            Month: mKeys[idx].split('-').reverse().join(' '), // Approx "01 2024" type
            Amount: amt,
            MA3: sum3 / count3,
            MA6: sum6 / count6
        };
    });

    const filteredTrends = filterDataByRange(totalsData, currentTrendRange, 'date');

    // 1. RENDER TREND CHART (DYNAMICALY FILTERED)
    const trendCtx = document.getElementById('investmentTrendChart');
    if (trendCtx) {
        const existing = Chart.getChart(trendCtx);
        if (existing) existing.destroy();
        new Chart(trendCtx.getContext('2d'), {
            type: 'line',
            data: {
                labels: filteredTrends.map(t => t.Month),
                datasets: [
                    { label: 'Net Monthly Investment', data: filteredTrends.map(t => t.Amount), borderColor: '#6366f1', backgroundColor: 'rgba(99, 102, 241, 0.1)', borderWidth: 3, pointRadius: 4, tension: 0.3, fill: true },
                    { label: '3M Avg', data: filteredTrends.map(t => t.MA3), borderColor: '#22d3ee', borderDash: [5, 5], fill: false, pointRadius: 0, tension: 0.4 },
                    { label: '6M Avg', data: filteredTrends.map(t => t.MA6), borderColor: '#f43f5e', borderDash: [5, 5], fill: false, pointRadius: 0, tension: 0.4 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ₹ ${fmtPrice(c.raw)}` } }
                },
                scales: {
                    x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { display: false } },
                    y: {
                        ...getSmartScale([...filteredTrends.map(t => t.Amount), ...filteredTrends.map(t => t.MA3), ...filteredTrends.map(t => t.MA6)]),
                        ticks: { color: '#64748b', callback: (v) => '₹' + fmtSmartValue(v) },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    }
                }
            }
        });
    }

    // 2. RENDER HIERARCHICAL PIVOT TABLE
    const head = document.getElementById('investment-pivot-head');
    const body = document.getElementById('investment-pivot-body');
    if (!head || !body) return;

    // Data Processing for Pivot
    const years = [...new Set(filteredPivot.map(p => p.Year))].sort();
    const fundsSet = new Set(filteredPivot.map(p => p['Fund Name']));
    const fundsMap = {}; // [fund][year][month] = amount

    filteredPivot.forEach(p => {
        if (!fundsMap[p['Fund Name']]) fundsMap[p['Fund Name']] = {};
        if (!fundsMap[p['Fund Name']][p.Year]) fundsMap[p['Fund Name']][p.Year] = { total: 0, months: {} };
        fundsMap[p['Fund Name']][p.Year].months[p.Month] = p.Amount;
        fundsMap[p['Fund Name']][p.Year].total += p.Amount;
    });

    const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // Header Construction
    let row1 = `<th class="sticky-col">Fund Name</th>`;
    let row2 = `<th class="sticky-col sub-header"></th>`;

    years.forEach(yr => {
        const isExp = expandedYears.has(yr);
        const span = isExp ? 13 : 1; // 12 months + 1 total
        row1 += `<th colspan="${span}" class="year-header" onclick="toggleYear(${yr})">
                    <i class="fas fa-chevron-${isExp ? 'down' : 'right'}"></i> ${yr}
                 </th>`;

        if (isExp) {
            ALL_MONTHS.forEach(m => row2 += `<th class="sub-header">${m}</th>`);
            row2 += `<th class="sub-header total-cell">Total</th>`;
        } else {
            row2 += `<th class="sub-header total-cell">Year Total</th>`;
        }
    });
    row1 += `<th rowspan="2" class="row-total-col">Overall Total</th>`;

    head.innerHTML = `<tr>${row1}</tr><tr>${row2}</tr>`;

    // Body Construction
    const sortedFunds = [...fundsSet].sort();
    body.innerHTML = sortedFunds.map(fName => {
        let cells = `<td class="sticky-col">${fName}</td>`;
        let overallTotal = 0;
        let prevPeriodAmount = 0; // For trend coloring

        years.forEach((yr, yIdx) => {
            const data = fundsMap[fName][yr] || { total: 0, months: {} };
            const isExp = expandedYears.has(yr);
            overallTotal += data.total;

            if (isExp) {
                // Color coding logic for months
                ALL_MONTHS.forEach(m => {
                    const amt = data.months[m] || 0;
                    let cls = "";
                    if (amt !== 0) { // Color if there's any net activity
                        if (prevPeriodAmount === 0 && amt > 0) cls = "positive"; // New investment
                        else if (amt > prevPeriodAmount) cls = "positive";
                        else if (amt < prevPeriodAmount) cls = "negative";
                    }
                    cells += `<td class="${cls}" style="text-align:right">${amt !== 0 ? fmtPrice(amt) : '-'}</td>`;
                    if (amt !== 0) prevPeriodAmount = amt;
                });
                // Year Total Cell
                cells += `<td class="total-cell" style="text-align:right">${data.total !== 0 ? fmtPrice(data.total) : '-'}</td>`;
            } else {
                // Year Summary Cell
                let cls = "";
                if (data.total !== 0) {
                    if (prevPeriodAmount === 0 && data.total > 0) cls = "positive";
                    else if (data.total > prevPeriodAmount) cls = "positive";
                    else if (data.total < prevPeriodAmount) cls = "negative";
                }
                cells += `<td class="total-cell ${cls}" style="text-align:right">${data.total !== 0 ? fmtPrice(data.total) : '-'}</td>`;
                if (data.total !== 0) prevPeriodAmount = data.total;
            }
        });

        cells += `<td class="row-total-col" style="text-align:right">${fmtPrice(overallTotal)}</td>`;
        return `<tr>${cells}</tr>`;
    }).join('') + renderColumnTotals(years, fundsMap, ALL_MONTHS);
}

function renderColumnTotals(years, fundsMap, ALL_MONTHS) {
    let cells = `<td class="sticky-col total-cell">GRAND TOTAL</td>`;
    let grandTotal = 0;

    years.forEach(yr => {
        const isExp = expandedYears.has(yr);
        let yrTotal = 0;
        const mTotals = {};
        ALL_MONTHS.forEach(m => mTotals[m] = 0);

        Object.values(fundsMap).forEach(fData => {
            if (fData[yr]) {
                yrTotal += fData[yr].total;
                ALL_MONTHS.forEach(m => mTotals[m] += (fData[yr].months[m] || 0));
            }
        });

        grandTotal += yrTotal;

        if (isExp) {
            ALL_MONTHS.forEach(m => cells += `<td class="total-cell" style="text-align:right">${mTotals[m] > 0 ? fmtPrice(mTotals[m]) : '-'}</td>`);
            cells += `<td class="total-cell highlight" style="text-align:right">${fmtPrice(yrTotal)}</td>`;
        } else {
            cells += `<td class="total-cell highlight" style="text-align:right">${fmtPrice(yrTotal)}</td>`;
        }
    });

    cells += `<td class="row-total-col highlight" style="text-align:right">${fmtPrice(grandTotal)}</td>`;
    return `<tr class="total-row">${cells}</tr>`;
}

function renderAllocations() {
    const filtered = getFilteredData();
    const cashFlows = dashboardData.cash_flows;

    // 1. Groupings for Pie (Value based)
    const catVal = {}; const amcVal = {}; const sectorVal = {}; const capVal = {};
    filtered.filter(s => s.current_val > 0).forEach(s => {
        catVal[s.Category] = (catVal[s.Category] || 0) + s.current_val;
        amcVal[s.AMC] = (amcVal[s.AMC] || 0) + s.current_val;
        sectorVal[s.Sector || 'Others'] = (sectorVal[s.Sector || 'Others'] || 0) + s.current_val;
        capVal[s.Cap || 'Others'] = (capVal[s.Cap || 'Others'] || 0) + s.current_val;
    });

    renderPie('catChart', catVal);
    renderPie('amcChart', amcVal);
    renderPie('sectorChart', sectorVal);
    renderPie('capChart', capVal);

    // 2. Groupings for Bar (XIRR based)
    const isinMeta = {};
    filtered.forEach(s => {
        isinMeta[s.ISIN] = { cat: s.Category, amc: s.AMC, sector: s.Sector || 'Others', cap: s.Cap || 'Others' };
    });

    const calculateSegmentXIRR = (groupByKey) => {
        const segments = {};
        cashFlows.forEach(cf => {
            const meta = isinMeta[cf.isin];
            if (!meta) return;
            const segment = meta[groupByKey];
            if (!segments[segment]) segments[segment] = [];
            segments[segment].push(cf);
        });

        const results = {};
        Object.entries(segments).forEach(([name, flows]) => {
            // Calculate XIRR for this segment's flows
            results[name] = calculateJS_XIRR(flows);
        });
        return results;
    };

    renderBar('catXirrChart', calculateSegmentXIRR('cat'));
    renderBar('amcXirrChart', calculateSegmentXIRR('amc'));
    renderBar('sectorXirrChart', calculateSegmentXIRR('sector'));
    renderBar('capXirrChart', calculateSegmentXIRR('cap'));
}

function renderBar(canvasId, dataObj) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const existing = Chart.getChart(canvas); if (existing) existing.destroy();

    const entries = Object.entries(dataObj)
        .filter(([k, v]) => Math.abs(v) > 0.01) // Filter out negligible/zero XIRR
        .sort((a, b) => b[1] - a[1]);

    const labels = entries.map(e => e[0]);
    const values = entries.map(e => e[1]);

    new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: values.map(v => v >= 0 ? 'rgba(74, 222, 128, 0.5)' : 'rgba(239, 68, 68, 0.5)'),
                borderColor: values.map(v => v >= 0 ? '#4ade80' : '#ef4444'),
                borderWidth: 1,
                borderRadius: 4,
                barThickness: entries.length > 5 ? 'flex' : 25
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements, chart) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const label = chart.data.labels[index];
                    const type = CHART_FILTER_TYPES[canvasId];
                    if (type) toggleFilter(type, label);
                }
            },
            onHover: (event, elements) => {
                event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `XIRR: ${context.parsed.y.toFixed(2)}%`
                    }
                },
                datalabels: { display: false } // Ensure datalabels are off for bars
            },
            scales: {
                y: {
                    ...getSmartScale(values),
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: 10 },
                        callback: (v) => v.toFixed(1) + '%'
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: 9 },
                        autoSkip: false,
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}


function renderPie(canvasId, dataObj) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const existing = Chart.getChart(canvas); if (existing) existing.destroy();

    const dataValues = Object.values(dataObj);
    const dataLabels = Object.keys(dataObj);
    const total = dataValues.reduce((a, b) => a + b, 0);

    new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: dataLabels,
            datasets: [{
                data: dataValues,
                backgroundColor: ['#6366f1', '#ec4899', '#8b5cf6', '#14b8a6', '#f59e0b', '#ef4444', '#f87171', '#fb923c', '#fbbf24', '#a3e635'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (event, elements, chart) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const label = chart.data.labels[index];
                    const type = CHART_FILTER_TYPES[canvasId];
                    if (type) toggleFilter(type, label);
                }
            },
            onHover: (event, elements) => {
                event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const label = context.label || '';
                            const value = context.parsed;
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) + '%' : '0%';
                            return `${label}: ₹${fmtPrice(value)} (${percentage})`;
                        }
                    }
                },
                datalabels: {
                    display: (context) => {
                        const val = context.dataset.data[context.dataIndex];
                        return (val / total) > 0.1; // Only show if > 10%
                    },
                    formatter: (value, context) => {
                        return context.chart.data.labels[context.dataIndex];
                    },
                    color: '#fff',
                    font: { weight: 'bold', size: 10 },
                    anchor: 'center',
                    align: 'center'
                }
            }
        }
    });
}

function fmtMoney(amount) { return '₹' + Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + (amount < 0 ? ' (Dr)' : ''); }
function fmtPrice(amount) { return amount.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

let currentRollingPeriod = '1Y';
function updateRollingView(period) {
    currentRollingPeriod = period;
    document.querySelectorAll('#rolling-period-filters .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.includes(period.replace('Y', ' Year')));
    });
    renderRollingStats();
}

function sortRolling(col) {
    if (currentRollingSort.column === col) currentRollingSort.order = currentRollingSort.order === 'asc' ? 'desc' : 'asc';
    else { currentRollingSort.column = col; currentRollingSort.order = 'desc'; }
    renderRollingStats();
}

function renderRollingStats() {
    const tableBody = document.getElementById('rolling-stats-body');
    if (!tableBody || !dashboardData.rolling_stats) return;

    // Filter by category/activity
    const filteredISINs = new Set(getFilteredData().map(s => s.ISIN));
    let statsList = [];

    Object.entries(dashboardData.rolling_stats).forEach(([isin, periods]) => {
        if (!filteredISINs.has(isin)) return;
        const stat = periods[currentRollingPeriod];
        if (!stat) return;

        const scheme = dashboardData.scheme_details.find(s => s.ISIN === isin);
        statsList.push({
            isin: isin,
            name: scheme ? scheme['Fund Name'] : isin,
            latest: stat.latest,
            min: stat.min,
            max: stat.max,
            mean: stat.mean,
            median: stat.median
        });
    });

    // Apply Sorting
    const col = currentRollingSort.column;
    const order = currentRollingSort.order === 'asc' ? 1 : -1;
    statsList.sort((a, b) => {
        const valA = (col === 'name') ? a[col].toLowerCase() : a[col];
        const valB = (col === 'name') ? b[col].toLowerCase() : b[col];
        if (valA < valB) return -order;
        if (valA > valB) return order;
        return 0;
    });

    tableBody.innerHTML = statsList.map(s => `
        <tr>
            <td style="font-weight:600">${s.name}</td>
            <td style="text-align:right" class="${s.latest >= 0 ? 'positive' : 'negative'}">${s.latest}%</td>
            <td style="text-align:right">${s.min}%</td>
            <td style="text-align:right">${s.max}%</td>
            <td style="text-align:right; font-weight:600">${s.mean}%</td>
            <td style="text-align:right">${s.median}%</td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center">No rolling data for selected window</td></tr>';
}

function renderComparison() {
    const tableBody = document.getElementById('comparison-body');
    if (!tableBody || !dashboardData.performance_comparison) return;

    const filteredData = getFilteredData();
    const filteredISINs = new Set(filteredData.map(s => s.ISIN));

    let html = "";
    dashboardData.performance_comparison.forEach(p => {
        if (!filteredISINs.has(p.isin)) return;
        const schemeData = filteredData.find(s => s.ISIN === p.isin);
        if (!schemeData) return;

        // Use dynamic XIRR from scheme flows
        const schemeFlows = dashboardData.cash_flows.filter(cf => cf.isin === p.isin);
        const xirrVal = calculateJS_XIRR(schemeFlows);
        const delta = xirrVal - p.fund_cagr;

        html += `
            <tr>
                <td style="font-weight:600">${p.fund}</td>
                <td style="text-align:right; font-weight:700">${xirrVal.toFixed(2)}%</td>
                <td style="text-align:right">${p.fund_cagr}%</td>
                <td style="text-align:right; font-weight:700" class="${delta >= 0 ? 'positive' : 'negative'}">
                    ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%
                </td>
                <td style="text-align:right; color:var(--text-muted)">${p.years} Years</td>
            </tr>
        `;
    });
    tableBody.innerHTML = html;
}

// MANAGEMENT LOGIC
let externalUrl = "#";

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        externalUrl = config.external_url;
    } catch (e) { console.error("Config failed", e); }
}

function openExternalUrl() {
    window.open(externalUrl, '_blank');
}

function renderStats() {
    const stats = dashboardData.data_stats;
    if (!stats) return;
    document.getElementById('stat-file-date').textContent = stats.last_file_date || 'N/A';
    document.getElementById('stat-txn-date').textContent = stats.last_txn_date || 'N/A';
    document.getElementById('stat-nav-date').textContent = stats.last_nav_date || 'N/A';
}

function showStatus(msg, type = 'info') {
    const statusEl = document.getElementById('op-status');
    statusEl.innerHTML = msg;
    statusEl.className = `status-msg ${type}`;
    statusEl.style.display = 'block';
    // Don't auto-hide if it's an error or success that might be missed
}

async function refreshNAV() {
    const btn = document.getElementById('btn-refresh-nav');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Refreshing...</span>';
    btn.disabled = true;
    showStatus("Fetching latest NAV data. This may take a minute...", "info");

    try {
        const res = await fetch('/api/refresh/nav', { method: 'POST' });
        const result = await res.json();
        if (result.status === 'success') {
            showStatus("NAV Refresh Complete. Reloading data...", "success");
            setTimeout(() => location.reload(), 1500);
        } else {
            showStatus("Error: " + result.message, "error");
        }
    } catch (e) {
        showStatus("Network Error: " + e.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function triggerUpload() {
    document.getElementById('cas-upload').click();
}

function updateFilename(event) {
    const file = event.target.files[0];
    if (file) {
        console.log("File selected:", file.name);
        document.getElementById('selected-filename').textContent = file.name;
        document.getElementById('btn-upload-pdf').disabled = false;
        document.getElementById('cas-password').focus();
        showStatus(`File "${file.name}" selected. Please enter password and click 'Upload & Process'.`, "info");
    }
}

async function handleFileUpload() {
    const fileInput = document.getElementById('cas-upload');
    const passwordInput = document.getElementById('cas-password');
    const file = fileInput.files[0];
    const password = passwordInput.value;

    if (!file) return;
    if (!password) {
        showStatus("Please enter the CAS PDF password", "error");
        passwordInput.focus();
        return;
    }

    const btn = document.getElementById('btn-upload-pdf');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Processing...</span>';
    btn.disabled = true;
    showStatus("Uploading and processing CAS PDF. Please wait...", "info");

    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);

    try {
        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const result = await res.json();
        if (result.status === 'success') {
            showStatus("PDF Processed Successfully. Reloading dashboard...", "success");
            setTimeout(() => location.reload(), 1500);
        } else {
            showStatus("Processing Failed: " + result.message, "error");
        }
    } catch (e) {
        showStatus("Upload Error: " + e.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        fileInput.value = ""; // Reset file input
        passwordInput.value = ""; // Reset password
        document.getElementById('selected-filename').textContent = "Select CAS PDF";
    }
}
