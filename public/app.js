const walletAddress = document.getElementById("walletAddress");
const enabledBots = document.getElementById("enabledBots");
const monitoringBots = document.getElementById("monitoringBots");
const allocationValue = document.getElementById("allocationValue");
const queueBadge = document.getElementById("queueBadge");
const totalPnlValue = document.getElementById("totalPnlValue");
const realizedPnlValue = document.getElementById("realizedPnlValue");
const openPnlValue = document.getElementById("openPnlValue");
const feesEarnedValue = document.getElementById("feesEarnedValue");
const openPositionsValue = document.getElementById("openPositionsValue");
const closedPositionsValue = document.getElementById("closedPositionsValue");
const orphanWarning = document.getElementById("orphanWarning");

function formatUsdKpi(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  return `${sign}$${amount.toFixed(2)}`;
}

const botsGrid = document.getElementById("botsGrid");
const pnlPositionsBody = document.getElementById("pnlPositionsBody");
const transactionsBody = document.getElementById("transactionsBody");
const transactionFilter = document.getElementById("transactionFilter");
const typeFilter = document.getElementById("typeFilter");
const statusFilter = document.getElementById("statusFilter");
const searchFilter = document.getElementById("searchFilter");
const createBotForm = document.getElementById("createBotForm");
const positionsBody = document.getElementById("positionsBody");

let latestBots = [];
let latestTransactions = [];
let latestPnlPositions = [];
let latestOrphanedPositions = [];
let previousBotIds = [];

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function formatValue(value) {
  return value ?? "-";
}

function formatUsd(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  return `${sign}$${amount.toFixed(2)}`;
}

function formatUsdPrecise(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const amount = Number(value);
  const sign = amount > 0 ? "+" : "";
  const decimals = Math.abs(amount) > 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `${sign}$${amount.toFixed(decimals)}`;
}

function pnlClass(value) {
  if (value == null || Number(value) === 0) return "flat";
  return Number(value) > 0 ? "positive" : "negative";
}

function formatPrice(value) {
  if (value == null) return "-";
  return Number(value).toFixed(4);
}

function getBadgeClass(runState) {
  if (runState === "Paused") return "paused";
  if (runState === "Waiting to retry") return "recovering";
  if (runState === "Reconciling timeout") return "recovering";
  if (runState === "Triggered") return "triggered";
  if (runState === "Running") return "running";
  return "idle";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatRecovery(bot) {
  const pending = bot.pendingRebalance;
  if (!pending) return "-";
  if (pending.nextRetryAt) return `Waiting to retry ${pending.phase} at ${formatDateTime(pending.nextRetryAt)}`;
  if (pending.recoveryReason) return `${pending.phase} (${pending.recoveryReason})`;
  return pending.phase ?? "-";
}

function renderWallet(wallet) {
  walletAddress.textContent = formatValue(wallet.walletAddress);
  enabledBots.textContent = formatValue(wallet.enabledBots);
  monitoringBots.textContent = formatValue(wallet.monitoringBots);
  allocationValue.textContent = `$${formatValue(wallet.totalAllocatedUsdc)}`;
  queueBadge.textContent = `Queue ${wallet.queueDepth}`;
  queueBadge.className = `badge ${wallet.queueDepth ? "triggered" : wallet.overAllocated ? "paused" : "idle"}`;
}

function renderPnl(summary) {
  totalPnlValue.textContent = formatUsdKpi(summary?.totalNetPnlUsdc);
  totalPnlValue.className = `kpi-value ${pnlClass(summary?.totalNetPnlUsdc)}`;
  realizedPnlValue.textContent = formatUsdKpi(summary?.realizedNetPnlUsdc);
  realizedPnlValue.className = `kpi-value ${pnlClass(summary?.realizedNetPnlUsdc)}`;
  openPnlValue.textContent = formatUsdKpi(summary?.openNetPnlUsdc);
  openPnlValue.className = `kpi-value ${pnlClass(summary?.openNetPnlUsdc)}`;
  feesEarnedValue.textContent = formatUsdKpi(summary?.feesEarnedUsdc);
  feesEarnedValue.className = `kpi-value ${pnlClass(summary?.feesEarnedUsdc)}`;
  openPositionsValue.textContent = formatValue(summary?.openPositionCount);
  closedPositionsValue.textContent = formatValue(summary?.closedPositionCount);

  if (!summary?.orphanedPositionCount) {
    orphanWarning.hidden = true;
    orphanWarning.textContent = "";
    return;
  }

  orphanWarning.hidden = false;
  orphanWarning.textContent = `${summary.orphanedPositionCount} wallet position${summary.orphanedPositionCount === 1 ? "" : "s"} not mapped to the bot PnL ledger.`;
}

function renderTransactionFilter(bots) {
  const previous = transactionFilter.value;
  transactionFilter.innerHTML = `<option value="">All bots</option>${bots
    .map((bot) => `<option value="${bot.id}">${bot.name}</option>`)
    .join("")}`;
  transactionFilter.value = bots.some((bot) => bot.id === previous) ? previous : "";
}

function renderSelectOptions(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = `<option value="">${allLabel}</option>${values
    .map((value) => `<option value="${value}">${value}</option>`)
    .join("")}`;
  select.value = values.includes(previous) ? previous : "";
}

function botCardHtml(bot) {
  return `
    <article class="bot-card" data-bot-id="${bot.id}">
      <div class="bot-head">
        <div>
          <p class="eyebrow">${bot.tokenPair} &middot; ${bot.strategy}</p>
          <h3>${bot.name}</h3>
        </div>
        <span class="badge ${getBadgeClass(bot.runState)}">${bot.runState}</span>
      </div>
      <dl class="bot-grid">
        <div><dt>Pool</dt><dd data-field="pool"><code title="${bot.dlmmPoolAddress}">${bot.dlmmPoolAddress}</code></dd></div>
        <div><dt>Allocation</dt><dd data-field="allocation">${formatValue(bot.allocationUsdc)} USDC</dd></div>
        <div><dt>Price Range</dt><dd data-field="priceRange">${formatPrice(bot.minPrice)} - ${formatPrice(bot.maxPrice)}</dd></div>
        <div><dt>Observed</dt><dd data-field="observed">${formatPrice(bot.lastObservedPrice)}</dd></div>
        <div><dt>Anchor</dt><dd data-field="anchor">${formatPrice(bot.lastCenterPrice)}</dd></div>
        <div><dt>Trigger State</dt><dd data-field="triggerState">${formatValue(bot.triggerState)}</dd></div>
        <div><dt>Position</dt><dd data-field="position">${bot.activePositionAddress ? `<code title="${bot.activePositionAddress}">${bot.activePositionAddress}</code>` : "-"}</dd></div>
        <div><dt>Last Action</dt><dd data-field="lastAction">${formatValue(bot.latestAction)}</dd></div>
        <div><dt>Open PnL</dt><dd data-field="openPnl" class="${pnlClass(bot.pnl?.openNetPnlUsdc)}">${formatUsd(bot.pnl?.openNetPnlUsdc)}</dd></div>
        <div><dt>Realized PnL</dt><dd data-field="realizedPnl" class="${pnlClass(bot.pnl?.realizedNetPnlUsdc)}">${formatUsd(bot.pnl?.realizedNetPnlUsdc)}</dd></div>
        <div><dt>Total PnL</dt><dd data-field="totalPnl" class="${pnlClass(bot.pnl?.totalNetPnlUsdc)}">${formatUsd(bot.pnl?.totalNetPnlUsdc)}</dd></div>
        <div><dt>Fees Earned</dt><dd data-field="feesEarned" class="${pnlClass(bot.pnl?.feesEarnedUsdc)}">${formatUsd(bot.pnl?.feesEarnedUsdc)}</dd></div>
        <div><dt>Pause Reason</dt><dd data-field="pauseReason">${formatValue(bot.pauseReason)}</dd></div>
        <div><dt>Recovery</dt><dd data-field="recovery">${formatRecovery(bot)}</dd></div>
      </dl>
      <div class="card-actions">
        <button class="play" data-action="start">Start</button>
        <button class="stop" data-action="stop">Stop</button>
        <button class="rebalance" data-action="rebalance">Rebalance</button>
        <button class="compound" data-action="compound">Compound</button>
        <button class="secondary" data-action="resume">Resume</button>
        <button class="secondary" data-action="archive">Archive</button>
      </div>
      <form class="edit-form" data-edit-form="${bot.id}">
        <label><span>Name</span><input name="name" value="${bot.name}" /></label>
        <label><span>Allocation</span><input name="allocationUsdc" type="number" min="1" step="0.01" value="${bot.allocationUsdc}" /></label>
        <label><span>Min Price</span><input name="minPrice" type="number" min="0" step="any" value="${bot.minPrice}" /></label>
        <label><span>Max Price</span><input name="maxPrice" type="number" min="0" step="any" value="${bot.maxPrice}" /></label>
        <label><span>Strategy</span>
          <select name="strategy">
            <option value="Spot" ${bot.strategy === "Spot" ? "selected" : ""}>Spot</option>
            <option value="Curve" ${bot.strategy === "Curve" ? "selected" : ""}>Curve</option>
            <option value="BidAsk" ${bot.strategy === "BidAsk" ? "selected" : ""}>BidAsk</option>
          </select>
        </label>
        <label><span>Poll Seconds</span><input name="pollSeconds" type="number" min="5" step="1" value="${bot.pollSeconds}" /></label>
        <label><span>Max Slippage</span><input name="maxSlippageBps" type="number" min="1" step="1" value="${bot.maxSlippageBps ?? 100}" /></label>
        <label class="checkbox-label"><input name="autoCompound" type="checkbox" ${bot.autoCompound ? "checked" : ""} /><span>Auto-Compound</span></label>
        <label><span>Compound Min (USDC)</span><input name="compoundMinValueUsdc" type="number" min="0" step="0.01" value="${bot.compoundMinValueUsdc ?? 0}" /></label>
        <div class="form-actions"><button class="secondary" type="submit">Save Changes</button></div>
      </form>
    </article>
  `;
}

function updateBotCard(card, bot) {
  const badge = card.querySelector(".badge");
  if (badge) {
    badge.textContent = bot.runState;
    badge.className = `badge ${getBadgeClass(bot.runState)}`;
  }

  const fields = {
    allocation: `${formatValue(bot.allocationUsdc)} USDC`,
    priceRange: `${formatPrice(bot.minPrice)} - ${formatPrice(bot.maxPrice)}`,
    observed: formatPrice(bot.lastObservedPrice),
    anchor: formatPrice(bot.lastCenterPrice),
    triggerState: formatValue(bot.triggerState),
    lastAction: formatValue(bot.latestAction),
    openPnl: formatUsd(bot.pnl?.openNetPnlUsdc),
    realizedPnl: formatUsd(bot.pnl?.realizedNetPnlUsdc),
    totalPnl: formatUsd(bot.pnl?.totalNetPnlUsdc),
    feesEarned: formatUsd(bot.pnl?.feesEarnedUsdc),
    pauseReason: formatValue(bot.pauseReason),
    recovery: formatRecovery(bot)
  };

  for (const [field, value] of Object.entries(fields)) {
    const dd = card.querySelector(`dd[data-field="${field}"]`);
    if (dd) {
      dd.textContent = value;
      if (["openPnl", "realizedPnl", "totalPnl", "feesEarned"].includes(field)) {
        const pnlKey = { openPnl: "openNetPnlUsdc", realizedPnl: "realizedNetPnlUsdc", totalPnl: "totalNetPnlUsdc", feesEarned: "feesEarnedUsdc" }[field];
        dd.className = pnlClass(bot.pnl?.[pnlKey]);
      }
    }
  }
}

function renderBots(bots) {
  latestBots = bots;
  renderTransactionFilter(bots);

  if (!bots.length) {
    botsGrid.innerHTML = `<p class="empty-state">No bots yet.</p>`;
    previousBotIds = [];
    return;
  }

  const currentIds = bots.map((bot) => bot.id);
  const idsMatch = currentIds.length === previousBotIds.length && currentIds.every((id, i) => id === previousBotIds[i]);

  if (idsMatch) {
    for (const bot of bots) {
      const card = botsGrid.querySelector(`[data-bot-id="${bot.id}"]`);
      if (card) updateBotCard(card, bot);
    }
  } else {
    botsGrid.innerHTML = bots.map(botCardHtml).join("");
    previousBotIds = currentIds;
  }
}

function renderTransactions(events) {
  if (!events.length) {
    transactionsBody.innerHTML = `<tr><td colspan="7" class="empty-row">No transaction events yet.</td></tr>`;
    return;
  }

  transactionsBody.innerHTML = events
    .map((event) => {
      const txId = event.txId ? `<code title="${event.txId}">${event.txId}</code>` : "-";
      return `
        <tr>
          <td>${formatValue(event.time)}</td>
          <td>${formatValue(event.botName ?? event.botId)}</td>
          <td>${formatValue(event.type)}</td>
          <td>${formatValue(event.status)}</td>
          <td>${txId}</td>
          <td>${formatValue(event.fees)}</td>
          <td>${formatValue(event.summary)}</td>
        </tr>
      `;
    })
    .join("");
}

function formatDuration(openedAt) {
  if (!openedAt) return "-";
  const ms = Date.now() - new Date(openedAt).getTime();
  if (ms < 0) return "-";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 1) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function computeYieldPct(record) {
  if (!record.entryCapitalUsdc || record.entryCapitalUsdc <= 0) return null;
  return ((record.feesEarnedUsdc ?? 0) / record.entryCapitalUsdc) * 100;
}

function computeAnnualisedApr(record) {
  if (!record.openedAt || !record.entryCapitalUsdc || record.entryCapitalUsdc <= 0) return null;
  const ms = Date.now() - new Date(record.openedAt).getTime();
  if (ms <= 0) return null;
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 0.0001) return null;
  return ((record.feesEarnedUsdc ?? 0) / record.entryCapitalUsdc / years) * 100;
}

function computePositionPnl(record) {
  if (!record || record.entryCapitalUsdc == null || record.latestGrossValueUsdc == null) return null;
  return record.latestGrossValueUsdc - record.entryCapitalUsdc;
}

function computePrincipalBalance(record) {
  if (!record || record.latestGrossValueUsdc == null) return null;
  return record.latestGrossValueUsdc - (record.feesEarnedUsdc ?? 0);
}

function formatTokenAmount(amount, decimals = 4) {
  if (amount == null) return "-";
  const n = Number(amount);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toFixed(decimals);
}

function formatPriceRange(lower, upper) {
  if (lower == null || upper == null) return "-";
  return `${Number(lower).toFixed(2)} - ${Number(upper).toFixed(2)}`;
}

function renderPositionsTable(positions) {
  if (!positions || !positions.length) {
    positionsBody.innerHTML = `<tr><td colspan="5" class="empty-row">No active LP positions.</td></tr>`;
    return;
  }

  positionsBody.innerHTML = positions.map((pos) => {
    const inRange = pos.currentPrice != null &&
      pos.currentPrice >= pos.lowerPrice && pos.currentPrice <= pos.upperPrice;
    const rangeWidth = pos.upperPrice - pos.lowerPrice;
    const cursorPct = rangeWidth > 0 && pos.currentPrice != null
      ? Math.max(0, Math.min(100, ((pos.currentPrice - pos.lowerPrice) / rangeWidth) * 100))
      : 50;
    const cursorColor = inRange ? "var(--green)" : "var(--red)";
    const pnlSign = pos.pnlUsdc != null && pos.pnlUsdc > 0 ? "+" : "";
    const pnlPctSign = pos.pnlPct != null && pos.pnlPct > 0 ? "+" : "";
    const label = pos.isOrphaned ? "Orphaned" : (pos.botName ?? "Position");

    return `
      <tr class="position-row" data-position-address="${pos.positionAddress}" data-bot-id="${pos.botId ?? ""}" data-pool="${pos.dlmmPoolAddress}">
        <td class="col-range">
          <div class="range-header">
            <strong>${formatPriceRange(pos.lowerPrice, pos.upperPrice)}</strong>
            ${pos.isOrphaned ? '<span class="badge paused" style="font-size:0.65rem;padding:1px 6px">Orphaned</span>' : ''}
          </div>
          <div class="range-sub">${pos.tokenBSymbol} per ${pos.tokenASymbol} &middot; ${label}</div>
          <div class="range-bar-mini">
            <div class="range-track">
              <div class="range-fill" style="left:0%;width:100%"></div>
              <div class="range-cursor" style="left:${cursorPct}%;border-color:${cursorColor}"></div>
            </div>
          </div>
        </td>
        <td class="col-liquidity">
          <strong>$${pos.totalValueUsdc.toFixed(2)}</strong>
          <div class="token-breakdown">
            <span class="token-line">${pos.tokenASymbol} ${formatTokenAmount(pos.tokenAAmount)} ($${pos.tokenAValueUsdc.toFixed(2)})</span>
            <span class="token-line">${pos.tokenBSymbol} ${formatTokenAmount(pos.tokenBAmount)} ($${pos.tokenBValueUsdc.toFixed(2)})</span>
          </div>
        </td>
        <td class="col-fees">
          <strong>$${pos.totalFeesUsdc.toFixed(2)}</strong>
          <span class="fee-pct">${pos.feePct.toFixed(2)}%</span>
          <div class="token-breakdown">
            <span class="token-line">${pos.tokenASymbol} ${formatTokenAmount(pos.feeTokenA)} ($${pos.feeTokenAUsdc.toFixed(2)})</span>
            <span class="token-line">${pos.tokenBSymbol} ${formatTokenAmount(pos.feeTokenB)} ($${pos.feeTokenBUsdc.toFixed(2)})</span>
          </div>
        </td>
        <td class="col-pnl">
          ${pos.pnlUsdc != null
            ? `<strong class="${pnlClass(pos.pnlUsdc)}">${pnlSign}$${pos.pnlUsdc.toFixed(2)}</strong>
               <span class="${pnlClass(pos.pnlPct)}">${pnlPctSign}${pos.pnlPct.toFixed(2)}%</span>`
            : `<span class="flat">-</span>`
          }
        </td>
        <td class="col-actions">
          ${pos.botId
            ? `<button class="compound btn-sm" data-action="compound" data-bot-id="${pos.botId}">Compound</button>
               <button class="secondary btn-sm" data-action="close-position" data-bot-id="${pos.botId}">Close</button>`
            : `<span class="hint">Close on Meteora</span>`
          }
        </td>
      </tr>
    `;
  }).join("");
}

function renderPnlPositions(records) {
  latestPnlPositions = records;

  if (!records.length) {
    pnlPositionsBody.innerHTML = `<tr><td colspan="10" class="empty-row">No tracked positions yet.</td></tr>`;
    return;
  }

  pnlPositionsBody.innerHTML = records
    .map((record) => `
      <tr>
        <td>${formatValue(record.botName)}</td>
        <td>${formatValue(record.tokenPair)}</td>
        <td>${formatValue(record.status)}</td>
        <td><code title="${record.positionAddress}">${record.positionAddress}</code></td>
        <td>${formatValue(record.openedAt)}</td>
        <td>${formatValue(record.closedAt)}</td>
        <td>${formatUsd(record.entryCapitalUsdc)}</td>
        <td>${formatUsd(record.status === "open" ? record.latestGrossValueUsdc : record.exitGrossValueUsdc)}</td>
        <td class="${pnlClass(record.status === "open" ? record.latestNetPnlUsdc : record.realizedNetPnlUsdc)}">${formatUsd(record.status === "open" ? record.latestNetPnlUsdc : record.realizedNetPnlUsdc)}</td>
        <td>${formatUsd(record.feesEarnedUsdc)} / ${formatUsd((record.cumulativeSwapFeesUsdc ?? 0) + (record.cumulativeTxFeesUsdc ?? 0))}</td>
      </tr>
    `)
    .join("");
}

function applyTransactionFilters() {
  const botId = transactionFilter.value;
  const type = typeFilter.value;
  const status = statusFilter.value;
  const query = searchFilter.value.trim().toLowerCase();

  return latestTransactions.filter((event) => {
    if (botId && event.botId !== botId) return false;
    if (type && event.type !== type) return false;
    if (status && event.status !== status) return false;
    if (!query) return true;

    const haystack = [event.botName, event.botId, event.type, event.status, event.txId, event.summary]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

async function refreshPnlPositions() {
  const payload = await request("/api/pnl");
  const positions = payload.positions ?? [];
  renderPnlPositions(positions);
}

async function refreshTransactions() {
  const payload = await request("/api/transactions");
  latestTransactions = payload.events ?? [];
  renderSelectOptions(typeFilter, [...new Set(latestTransactions.map((event) => event.type).filter(Boolean))], "All types");
  renderSelectOptions(statusFilter, [...new Set(latestTransactions.map((event) => event.status).filter(Boolean))], "All statuses");
  renderTransactions(applyTransactionFilters());
}

async function refreshStatus() {
  const payload = await request("/api/status");
  renderWallet(payload.wallet);
  renderPnl(payload.pnl);
  renderBots(payload.bots ?? []);
  renderPositionsTable(payload.allPositions ?? []);
  await Promise.all([refreshPnlPositions(), refreshTransactions()]);
}

createBotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createBotForm);
  const payload = Object.fromEntries(formData.entries());

  for (const key of Object.keys(payload)) {
    if (key !== "name" && key !== "dlmmPoolAddress" && key !== "strategy") {
      payload[key] = Number(payload[key]);
    }
  }

  try {
    await request("/api/bots", { method: "POST", body: JSON.stringify(payload) });
    createBotForm.reset();
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

botsGrid.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.dataset.action;
  if (!action) return;

  const card = target.closest("[data-bot-id]");
  if (!card) return;

  const botId = card.getAttribute("data-bot-id");
  if (!botId) return;

  try {
    if (action === "archive") {
      await request(`/api/bots/${botId}`, { method: "DELETE" });
    } else if (action === "rebalance") {
      await request(`/api/bots/${botId}/rebalance`, { method: "POST" });
    } else {
      await request(`/api/bots/${botId}/${action}`, { method: "POST" });
    }
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

botsGrid.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  event.preventDefault();
  const botId = form.getAttribute("data-edit-form");
  if (!botId) return;

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  // Handle checkbox: FormData omits unchecked, includes "on" for checked
  const autoCompoundEl = form.querySelector('input[name="autoCompound"]');
  if (autoCompoundEl) {
    payload.autoCompound = autoCompoundEl.checked;
  }

  for (const key of Object.keys(payload)) {
    if (key !== "name" && key !== "strategy" && key !== "autoCompound") {
      payload[key] = Number(payload[key]);
    }
  }

  try {
    await request(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify(payload) });
    await refreshStatus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
});

positionsBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.dataset.action;
  if (!action) return;

  const botId = target.dataset.botId;
  if (!botId) return;

  if (action === "compound") {
    target.disabled = true;
    target.textContent = "Compounding...";

    try {
      const result = await request(`/api/bots/${botId}/compound`, { method: "POST" });
      alert(`Fees compounded. TokenA: ${result?.feesTokenA ?? "0"}, TokenB: ${result?.feesTokenB ?? "0"}`);
      await refreshStatus();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      target.disabled = false;
      target.textContent = "Compound";
    }
    return;
  }

  if (action === "close-position") {
    if (!confirm("Close this LP position? Tokens will be returned to the wallet.")) return;

    target.disabled = true;
    target.textContent = "Closing...";

    try {
      const result = await request(`/api/bots/${botId}/close-position`, { method: "POST" });
      alert(`Position closed. Tx: ${result?.txId ?? "unknown"}`);
      await refreshStatus();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      target.disabled = false;
      target.textContent = "Close";
    }
  }
});

transactionFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));
typeFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));
statusFilter.addEventListener("change", () => renderTransactions(applyTransactionFilters()));

let searchTimeout;
searchFilter.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => renderTransactions(applyTransactionFilters()), 300);
});

refreshStatus().catch((error) => console.error(error));

setInterval(() => {
  refreshStatus().catch((error) => console.error(error));
}, 15000);
