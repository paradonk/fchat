const authMessage = document.getElementById("authMessage");
const tabButtons = document.querySelectorAll(".tab-button");
const forms = document.querySelectorAll(".auth-form");

const basePath = window.location.pathname
  .replace(/\/(login\.html)?$/, "")
  .replace(/\/$/, "");

function appUrl(path) {
  return `${basePath}${path}`;
}

async function ensureLoggedOutUsersStayHere() {
  const response = await fetch(appUrl("/api/session"));
  const data = await response.json();
  if (data.authenticated) {
    window.location.href = appUrl("/chat.html");
  }
}

function setMessage(text, isError = false) {
  authMessage.textContent = text;
  authMessage.classList.toggle("error", isError);
  authMessage.classList.toggle("success", !isError && Boolean(text));
}

function switchTab(name) {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  forms.forEach((form) => {
    form.classList.toggle("active", form.dataset.form === name);
  });
  setMessage("");
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

async function submitAuthForm(url, form) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  window.location.href = appUrl("/chat.html");
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");
  try {
    await submitAuthForm(appUrl("/api/login"), event.currentTarget);
  } catch (error) {
    setMessage(error.message, true);
  }
});

document.getElementById("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");
  try {
    await submitAuthForm(appUrl("/api/register"), event.currentTarget);
  } catch (error) {
    setMessage(error.message, true);
  }
});

ensureLoggedOutUsersStayHere();
