const state = {
  sessionId: null,
  busy: false,
};

const sessionMeta = document.getElementById("sessionMeta");
const statusMeta = document.getElementById("statusMeta");
const responseBox = document.getElementById("responseBox");
const stateBox = document.getElementById("stateBox");
const traceBox = document.getElementById("traceBox");
const quoteContent = document.getElementById("quoteContent");
const errorBox = document.getElementById("errorBox");
const messageInput = document.getElementById("messageInput");
const workflowSteps = [...document.querySelectorAll(".workflow-step")];
const actionButtons = [...document.querySelectorAll(".button-row button")];
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const samplePricing = {
  flightPerTraveler: 150,
  hotelPerTraveler: 150,
  insurancePerTraveler: 10,
};

const statusLabels = {
  collecting_intent: "Gathering details",
  awaiting_approval: "Approval needed",
  ready_to_resume: "Ready to resume",
  completed: "Completed",
  blocked: "Stopped by policy",
};

function setBusy(isBusy) {
  state.busy = isBusy;
  actionButtons.forEach((button) => {
    button.disabled = isBusy;
    button.textContent = isBusy && button.id === "sendMessage" ? "Running..." : button.dataset.label;
  });
  messageInput.disabled = isBusy;
  document.getElementById("newSession").disabled = isBusy;
}

function renderWorkflow(status) {
  const completedThrough = {
    collecting_intent: 0,
    awaiting_approval: 2,
    ready_to_resume: 3,
    completed: 4,
    blocked: 2,
  }[status] ?? 0;
  const activeStep = {
    collecting_intent: "request",
    awaiting_approval: "policy",
    ready_to_resume: "book",
    completed: null,
    blocked: "policy",
  }[status];

  workflowSteps.forEach((step, index) => {
    const name = step.dataset.step;
    step.classList.toggle("done", index < completedThrough);
    step.classList.toggle("active", name === activeStep);
    if (name === activeStep) {
      step.setAttribute("aria-current", "step");
    } else {
      step.removeAttribute("aria-current");
    }
  });
}

function renderQuotes(payload) {
  const quotes = payload.state?.quotes;
  if (!quotes || !payload.state?.request?.destination) {
    quoteContent.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-quotes";
    empty.textContent = "Your estimate will appear here after the request is complete.";
    quoteContent.append(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "quote-grid";
  [
    ["Return flight", quotes.flight],
    ["5-night lodging", quotes.hotel],
    ["Travel insurance", quotes.insurance],
  ].forEach(([label, amount]) => {
    const item = document.createElement("div");
    item.className = "quote-item";
    const title = document.createElement("span");
    title.className = "quote-label";
    title.textContent = label;
    const value = document.createElement("strong");
    value.className = "quote-value";
    value.textContent = usdFormatter.format(Number(amount));
    item.append(title, value);
    grid.append(item);
  });

  const total = document.createElement("div");
  total.className = "quote-total";
  const totalLabel = document.createElement("span");
  totalLabel.textContent = `${payload.state.request.origin} → ${payload.state.request.destination} · USD`;
  const totalAmount = document.createElement("strong");
  totalAmount.textContent = usdFormatter.format(Number(quotes.total));
  total.append(totalLabel, totalAmount);
  quoteContent.replaceChildren(grid, total);
}

function updatePricePreview() {
  const preview = document.getElementById("pricePreview");
  const paragraphs = [];
  const flightPerTraveler = samplePricing.flightPerTraveler;
  const tripPerTraveler =
    flightPerTraveler + samplePricing.hotelPerTraveler + samplePricing.insurancePerTraveler;
  const budgetMatch = messageInput.value.match(
    /\bbudget\b\s*(?:(?:of|to|is)\s*)?[:=]?\s*\$?\s*(\d{1,6}(?:,\d{3})*)/i,
  );
  const travelersMatch = messageInput.value.match(/\b(\d+)\s+(?:traveler|travelers|people|person)\b/i);
  const approvalMatch = messageInput.value.match(/\bapproval\s*limit\D*(\d{3,5})/i);
  const budget = budgetMatch ? Number(budgetMatch[1].replaceAll(",", "")) : null;
  const travelers = travelersMatch ? Math.max(1, Number(travelersMatch[1])) : null;
  const approvalLimit = approvalMatch ? Number(approvalMatch[1]) : 600;

  paragraphs.push(
    `Sample round-trip flight: ${usdFormatter.format(flightPerTraveler)} per traveler. ` +
      `Estimated trip total: ${usdFormatter.format(tripPerTraveler)} per traveler, including five-night lodging and insurance.`,
  );

  let result = "";
  if (budget === null || travelers === null) {
    paragraphs.push("Enter a budget and traveler count to check whether the sample estimate fits.");
  } else {
    const flightTotal = flightPerTraveler * travelers;
    const tripTotal = tripPerTraveler * travelers;
    paragraphs[0] +=
      ` For ${travelers} ${travelers === 1 ? "traveler" : "travelers"}, that's ` +
      `${usdFormatter.format(flightTotal)} for flights and ${usdFormatter.format(tripTotal)} for the estimated trip.`;

    if (budget < flightTotal) {
      result = "under-flight";
      paragraphs.push(
        `Your budget of ${usdFormatter.format(budget)} is below the sample round-trip flight cost of ` +
          `${usdFormatter.format(flightTotal)}, so it won't cover the flights. The full trip estimate is ` +
          `${usdFormatter.format(tripTotal)}. Please revise the budget before running.`,
      );
    } else if (budget < tripTotal) {
      result = "under-trip";
      paragraphs.push(
        `Your budget covers the estimated flights but is below the full trip estimate of ` +
          `${usdFormatter.format(tripTotal)}. Please revise the budget before running.`,
      );
    } else if (tripTotal >= approvalLimit) {
      result = "covered";
      paragraphs.push(
        `Your budget covers the sample estimate. Since the total is at or above the ` +
          `${usdFormatter.format(approvalLimit)} approval limit, approval will be required.`,
      );
    } else {
      result = "covered";
      paragraphs.push(
        `Your budget covers the sample estimate, which is below the ${usdFormatter.format(approvalLimit)} ` +
          "approval limit, so booking can complete automatically.",
      );
    }
  }

  preview.dataset.result = result;
  preview.replaceChildren(...paragraphs.map((text) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  }));
}

function renderTrace(events) {
  if (!events?.length) {
    const empty = document.createElement("p");
    empty.className = "trace-empty";
    empty.textContent = "Activity will show up as the workflow runs.";
    traceBox.replaceChildren(empty);
    return;
  }

  const items = events.slice().reverse().map((event) => {
    const item = document.createElement("article");
    item.className = "trace-item";

    const title = document.createElement("h3");
    title.className = "trace-title";
    title.textContent = event.step.replaceAll("_", " ");

    const message = document.createElement("p");
    message.className = "trace-message";
    message.textContent = event.message;

    const time = document.createElement("time");
    time.className = "trace-time";
    time.dateTime = event.ts;
    time.textContent = new Date(event.ts).toLocaleString();
    item.append(title, message, time);

    if (Object.keys(event.data ?? {}).length) {
      const details = document.createElement("pre");
      details.className = "trace-data";
      details.textContent = JSON.stringify(event.data, null, 2);
      item.append(details);
    }
    return item;
  });
  traceBox.replaceChildren(...items);
}

function render(payload) {
  state.sessionId = payload.session_id;
  sessionMeta.textContent = `Run ${payload.session_id.slice(0, 8)}`;

  const status = payload.status;
  statusMeta.textContent = statusLabels[status] ?? status;
  statusMeta.dataset.status = status;
  responseBox.textContent = payload.message;
  responseBox.dataset.status = status;
  stateBox.textContent = JSON.stringify(payload.state, null, 2);
  const approvalLimit = payload.state?.policy?.approval_limit;
  if (Number.isFinite(approvalLimit)) {
    document.getElementById("approvalLimit").textContent =
      `Approval limit: ${usdFormatter.format(approvalLimit)}. Quotes at or above this amount require approval.`;
  }
  updatePricePreview();
  renderQuotes(payload);
  renderTrace(payload.trace);
  renderWorkflow(status);

  const sendButton = document.getElementById("sendMessage");
  sendButton.hidden = status !== "collecting_intent" && status !== "blocked";
  sendButton.dataset.label = status === "blocked" ? "Revise request" : "Run workflow";
  sendButton.textContent = sendButton.dataset.label;
  document.getElementById("approve").hidden = status !== "awaiting_approval";
  document.getElementById("deny").hidden = status !== "awaiting_approval";
  document.getElementById("resume").hidden = status !== "ready_to_resume";
}

async function callJson(url, payload = null) {
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || "Request failed. Please try again.");
  }
  return data;
}

async function runAction(action) {
  if (state.busy) return;
  errorBox.hidden = true;
  setBusy(true);
  try {
    const payload = await action();
    render(payload);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    setBusy(false);
  }
}

async function requireSession() {
  if (state.sessionId) return state.sessionId;
  const payload = await callJson("/api/session", {});
  render(payload);
  return payload.session_id;
}

actionButtons.forEach((button) => {
  button.dataset.label = button.textContent;
});

document.getElementById("newSession").addEventListener("click", () => {
  runAction(() => callJson("/api/session", {}));
});

messageInput.addEventListener("input", updatePricePreview);
updatePricePreview();

document.getElementById("sendMessage").addEventListener("click", () => {
  runAction(async () => {
    const sessionId = await requireSession();
    return callJson("/api/chat", {
      session_id: sessionId,
      message: messageInput.value,
    });
  });
});

document.getElementById("approve").addEventListener("click", () => {
  runAction(async () => {
    const sessionId = await requireSession();
    return callJson("/api/approval", { session_id: sessionId, approve: true });
  });
});

document.getElementById("deny").addEventListener("click", () => {
  runAction(async () => {
    const sessionId = await requireSession();
    return callJson("/api/approval", { session_id: sessionId, approve: false });
  });
});

document.getElementById("resume").addEventListener("click", () => {
  runAction(async () => {
    const sessionId = await requireSession();
    return callJson("/api/resume", { session_id: sessionId });
  });
});
