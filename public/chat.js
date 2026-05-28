const messagesContainer = document.getElementById("messages");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const imageInput = document.getElementById("imageInput");
const imagePreview = document.getElementById("imagePreview");
const imagePreviewGrid = document.getElementById("imagePreviewGrid");
const logoutButton = document.getElementById("logoutButton");
const currentUserLabel = document.getElementById("currentUser");
const chatStatus = document.getElementById("chatStatus");
const typingIndicator = document.getElementById("typingIndicator");
const onlineCount = document.getElementById("onlineCount");
const onlineList = document.getElementById("onlineList");
const imageViewer = document.getElementById("imageViewer");
const viewerImage = document.getElementById("viewerImage");
const downloadImageLink = document.getElementById("downloadImageLink");
const closeViewerButton = document.getElementById("closeViewerButton");
const viewerPrevButton = document.getElementById("viewerPrevButton");
const viewerNextButton = document.getElementById("viewerNextButton");
const viewerCounter = document.getElementById("viewerCounter");

let currentUser = null;
let socket = null;
let selectedImageFiles = [];
let previewObjectUrls = [];
let unreadCount = 0;

const basePath = window.location.pathname
  .replace(/\/(chat\.html)?$/, "")
  .replace(/\/$/, "");

function appUrl(path) {
  return `${basePath}${path}`;
}

function assetUrl(path) {
  if (!path || !path.startsWith("/")) return path || "";
  return appUrl(path);
}

// Typing indicator state
const typingUsers = new Map();
let typingTimeout = null;
const TYPING_DEBOUNCE_MS = 1500;

function setStatus(text, isError = false) {
  chatStatus.textContent = text;
  chatStatus.classList.toggle("error", isError);
  chatStatus.classList.toggle("success", !isError && Boolean(text));
}

function formatDateSeparator(isoString) {
  const d = new Date(isoString);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + `(${day})`;
}

function formatTimePart(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Tracks the last date string rendered, to know when to insert a separator
let lastRenderedDate = null;

function createDateSeparator(isoString) {
  const el = document.createElement("div");
  el.className = "date-separator";
  el.dataset.date = new Date(isoString).toDateString();
  el.innerHTML = `<span>${escapeHtml(formatDateSeparator(isoString))}</span>`;
  return el;
}

function maybeInsertDateSeparator(isoString) {
  const dateStr = new Date(isoString).toDateString();
  if (dateStr !== lastRenderedDate) {
    lastRenderedDate = dateStr;
    messagesContainer.appendChild(createDateSeparator(isoString));
  }
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function buildImageGroupHtml(images, isOwnMessage) {
  return images.map((img, i) => `
    <figure class="chat-image-item" data-message-id="${img.id}">
      <button
        class="chat-image-button"
        type="button"
        data-image-url="${escapeHtml(assetUrl(img.image_url))}"
        data-image-name="${escapeHtml(img.original_name || "shared-image")}"
        aria-label="View image ${i + 1}"
      >
        <img class="chat-image" src="${escapeHtml(assetUrl(img.image_url))}" alt="Image ${i + 1}">
      </button>
      ${isOwnMessage
        ? `<button class="delete-image-item-button" type="button" data-message-id="${img.id}" aria-label="Delete image ${i + 1}">✕</button>`
        : ""}
    </figure>`
  ).join("");
}

function renderMessage(message) {
  const isOwnMessage = currentUser && String(message.user.id) === String(currentUser.id);
  const wrapper = document.createElement("article");
  wrapper.className = `message-row${isOwnMessage ? " own" : ""}`;

  const timeHtml = `
    <div class="message-time">
      <span>${escapeHtml(formatTimePart(message.created_at))}</span>
      ${isOwnMessage
        ? message.message_type === "image_group"
          ? `<button class="delete-message-button" type="button" data-group-id="${message.group_id}" aria-label="Delete all images">Delete</button>`
          : `<button class="delete-message-button" type="button" data-message-id="${message.id}" aria-label="Delete message">Delete</button>`
        : ""}
    </div>`;

  const senderHtml = !isOwnMessage
    ? `<div class="message-sender">${escapeHtml(message.user.display_name)}</div>`
    : "";

  let bodyHtml;

  if (message.message_type === "image_group") {
    wrapper.dataset.groupId = message.group_id;
    bodyHtml = `<div class="chat-image-group" data-count="${message.images.length}">${buildImageGroupHtml(message.images, isOwnMessage)}</div>`;
  } else if (message.message_type === "image") {
    wrapper.dataset.messageId = message.id;
    bodyHtml = `
      <button
        class="chat-image-button"
        type="button"
        data-image-url="${escapeHtml(assetUrl(message.image_url))}"
        data-image-name="${escapeHtml(message.original_name || "shared-image")}"
      >
        <img class="chat-image" src="${escapeHtml(assetUrl(message.image_url))}" alt="${escapeHtml(message.original_name || "Shared image")}">
      </button>`;
  } else {
    wrapper.dataset.messageId = message.id;
    bodyHtml = `<div class="message-bubble">${escapeHtml(message.message || "")}</div>`;
  }

  wrapper.innerHTML = `
    <div class="message-content">
      ${senderHtml}
      <div class="message-with-time">
        <div class="message-body">${bodyHtml}</div>
        ${timeHtml}
      </div>
    </div>
  `;

  messagesContainer.appendChild(wrapper);
}

function renderMessages(messages) {
  messagesContainer.innerHTML = "";
  lastRenderedDate = null;
  messages.forEach((msg) => {
    maybeInsertDateSeparator(msg.created_at);
    renderMessage(msg);
  });
  scrollToBottom();
}

// --- Image viewer with prev/next navigation ---

let viewerImages = [];
let viewerIndex = 0;

function updateViewerDisplay() {
  const current = viewerImages[viewerIndex];
  viewerImage.src = current.imageUrl;
  viewerImage.alt = current.imageName || "Full-size chat image";
  downloadImageLink.href = current.imageUrl;
  downloadImageLink.download = current.imageName || "shared-image";

  const multiple = viewerImages.length > 1;
  viewerCounter.hidden = !multiple;
  viewerPrevButton.hidden = !multiple;
  viewerNextButton.hidden = !multiple;

  if (multiple) {
    viewerCounter.textContent = `${viewerIndex + 1} / ${viewerImages.length}`;
    viewerPrevButton.disabled = viewerIndex === 0;
    viewerNextButton.disabled = viewerIndex === viewerImages.length - 1;
  }
}

function showImageViewer(imageUrl, imageName, images = null, index = 0) {
  viewerImages = images && images.length > 1 ? images : [{ imageUrl, imageName }];
  viewerIndex = images && images.length > 1 ? index : 0;
  updateViewerDisplay();

  if (typeof imageViewer.showModal === "function") {
    imageViewer.showModal();
  } else {
    imageViewer.setAttribute("open", "open");
  }
}

function navigateViewer(delta) {
  const next = viewerIndex + delta;
  if (next < 0 || next >= viewerImages.length) return;
  viewerIndex = next;
  updateViewerDisplay();
}

function hideImageViewer() {
  if (typeof imageViewer.close === "function") {
    imageViewer.close();
  } else {
    imageViewer.removeAttribute("open");
  }
}

// --- Typing indicator ---

function renderTypingIndicator() {
  const names = Array.from(typingUsers.values());
  if (names.length === 0) {
    typingIndicator.hidden = true;
    typingIndicator.textContent = "";
    return;
  }
  const label = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing…`;
  typingIndicator.textContent = label;
  typingIndicator.hidden = false;
}

function updateTypingUser(user, isTyping) {
  if (isTyping) {
    typingUsers.set(user.id, user.display_name);
  } else {
    typingUsers.delete(user.id);
  }
  renderTypingIndicator();
}

function resizeMessageInput() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

messageInput.addEventListener("input", () => {
  resizeMessageInput();
  if (!socket) return;
  socket.emit("chat:typing", true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit("chat:typing", false);
  }, TYPING_DEBOUNCE_MS);
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

// --- Online users ---

function renderOnlineUsers(users) {
  onlineCount.textContent = users.length;
  onlineList.innerHTML = users
    .map((u) => `<li>${escapeHtml(u.display_name)}</li>`)
    .join("");
}

// --- Notifications ---

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function notifyNewMessage(message) {
  if (!currentUser || String(message.user.id) === String(currentUser.id)) return;
  if (document.hidden) {
    unreadCount++;
    document.title = `(${unreadCount}) Family Chat`;

    if ("Notification" in window && Notification.permission === "granted") {
      const body = message.message_type === "image" || message.message_type === "image_group"
        ? "Sent a photo"
        : message.message;
      new Notification(message.user.display_name, { body });
    }
  }
}

window.addEventListener("focus", () => {
  unreadCount = 0;
  document.title = "Family Chat";
});

// --- Message deletion ---

async function deleteMessage(messageId) {
  if (!confirm("Delete this message?")) return;
  try {
    const response = await fetch(appUrl(`/api/messages/${messageId}`), { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) setStatus(data.error || "Could not delete message.", true);
  } catch {
    setStatus("Could not delete message.", true);
  }
}

async function deleteGroup(groupId) {
  if (!confirm("Delete all images in this group?")) return;
  try {
    const response = await fetch(appUrl(`/api/messages/group/${encodeURIComponent(groupId)}`), { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) setStatus(data.error || "Could not delete group.", true);
  } catch {
    setStatus("Could not delete group.", true);
  }
}

// --- Session & messages ---

async function loadSession() {
  const response = await fetch(appUrl("/api/session"));
  const data = await response.json();

  if (!data.authenticated) {
    window.location.href = appUrl("/login.html");
    return;
  }

  currentUser = data.user;
  currentUserLabel.textContent = `Logged in as ${currentUser.display_name}`;
}

async function loadMessages() {
  const response = await fetch(appUrl("/api/messages"));

  if (response.status === 401) {
    window.location.href = appUrl("/login.html");
    return;
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not load messages.");
  }

  renderMessages(data.messages);
}

// --- Socket ---

function connectSocket() {
  socket = io({ path: appUrl("/socket.io") });

  socket.on("connect", () => {
    setStatus("");
  });

  socket.on("chat:ready", ({ user }) => {
    currentUser = user;
    currentUserLabel.textContent = `Logged in as ${currentUser.display_name}`;
    requestNotificationPermission();
  });

  socket.on("chat:message", (message) => {
    maybeInsertDateSeparator(message.created_at);
    renderMessage(message);
    scrollToBottom();
    notifyNewMessage(message);
  });

  socket.on("chat:delete_group", ({ group_id }) => {
    const article = messagesContainer.querySelector(`article[data-group-id="${group_id}"]`);
    if (article) article.remove();
  });

  socket.on("chat:delete", ({ id }) => {
    // Standalone message article
    const article = messagesContainer.querySelector(`article[data-message-id="${id}"]`);
    if (article) { article.remove(); return; }

    // Image inside a group
    const imageItem = messagesContainer.querySelector(`.chat-image-item[data-message-id="${id}"]`);
    if (imageItem) {
      const group = imageItem.closest(".chat-image-group");
      imageItem.remove();
      if (group) {
        const remaining = group.querySelectorAll(".chat-image-item").length;
        group.dataset.count = remaining;
        if (remaining === 0) group.closest("article").remove();
      }
    }
  });

  socket.on("chat:typing", ({ user, isTyping }) => {
    updateTypingUser(user, isTyping);
  });

  socket.on("chat:online", (users) => {
    renderOnlineUsers(users);
  });

  socket.on("chat:error", ({ error }) => {
    setStatus(error || "Something went wrong.", true);
  });

  socket.on("connect_error", () => {
    setStatus("Real-time connection failed. Refresh after logging in again.", true);
  });
}

// --- Image preview ---

async function uploadSelectedImages(files) {
  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));

  const response = await fetch(appUrl("/api/upload-image"), { method: "POST", body: formData });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not upload image.");
  }
}

function syncImageInputFiles() {
  const dataTransfer = new DataTransfer();
  selectedImageFiles.forEach((file) => dataTransfer.items.add(file));
  imageInput.files = dataTransfer.files;
}

function renderSelectedImagePreviews() {
  previewObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  previewObjectUrls = [];
  imagePreviewGrid.innerHTML = "";

  if (selectedImageFiles.length === 0) {
    imagePreview.hidden = true;
    return;
  }

  selectedImageFiles.forEach((file, index) => {
    const objectUrl = URL.createObjectURL(file);
    previewObjectUrls.push(objectUrl);

    const previewItem = document.createElement("figure");
    previewItem.className = "image-preview-item";
    previewItem.innerHTML = `
      <button class="preview-remove-button" type="button" data-index="${index}" aria-label="Remove image ${index + 1}">x</button>
      <img class="image-preview-thumb" src="${objectUrl}" alt="Selected image preview ${index + 1}">
    `;
    imagePreviewGrid.appendChild(previewItem);
  });

  imagePreview.hidden = false;
}

function clearSelectedImages() {
  selectedImageFiles = [];
  previewObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  previewObjectUrls = [];
  syncImageInputFiles();
  renderSelectedImagePreviews();
}

// --- Event listeners ---

imageInput.addEventListener("change", () => {
  selectedImageFiles = Array.from(imageInput.files || []);
  renderSelectedImagePreviews();
});


imagePreviewGrid.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".preview-remove-button");
  if (!removeButton) return;

  const index = Number(removeButton.dataset.index);
  if (Number.isNaN(index)) return;

  selectedImageFiles.splice(index, 1);
  syncImageInputFiles();
  renderSelectedImagePreviews();
});

messagesContainer.addEventListener("click", (event) => {
  const imageTrigger = event.target.closest(".chat-image-button");
  if (imageTrigger) {
    const groupEl = imageTrigger.closest(".chat-image-group");
    if (groupEl) {
      const items = Array.from(groupEl.querySelectorAll(".chat-image-item"));
      const images = items.map((item) => {
        const btn = item.querySelector(".chat-image-button");
        return { imageUrl: btn.dataset.imageUrl || "", imageName: btn.dataset.imageName || "shared-image" };
      });
      const currentItem = imageTrigger.closest(".chat-image-item");
      showImageViewer(images[0].imageUrl, images[0].imageName, images, items.indexOf(currentItem));
    } else {
      showImageViewer(imageTrigger.dataset.imageUrl || "", imageTrigger.dataset.imageName || "shared-image");
    }
    return;
  }

  const deleteBtn = event.target.closest(".delete-message-button, .delete-image-item-button");
  if (deleteBtn) {
    if (deleteBtn.dataset.groupId) {
      deleteGroup(deleteBtn.dataset.groupId);
    } else {
      const messageId = Number(deleteBtn.dataset.messageId);
      if (messageId) deleteMessage(messageId);
    }
  }
});

closeViewerButton.addEventListener("click", hideImageViewer);
viewerPrevButton.addEventListener("click", () => navigateViewer(-1));
viewerNextButton.addEventListener("click", () => navigateViewer(1));

imageViewer.addEventListener("click", (event) => {
  if (event.target === imageViewer) hideImageViewer();
});

imageViewer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") navigateViewer(-1);
  if (event.key === "ArrowRight") navigateViewer(1);
  if (event.key === "Escape") hideImageViewer();
});

imageViewer.addEventListener("close", () => {
  viewerImage.removeAttribute("src");
  viewerImages = [];
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  const files = [...selectedImageFiles];

  if (!socket) return;

  if (!message && files.length === 0) {
    setStatus("Type a message or choose an image.", true);
    return;
  }

  try {
    if (message) {
      socket.emit("chat:message", { message });
      messageInput.value = "";
      resizeMessageInput();
      clearTimeout(typingTimeout);
      socket.emit("chat:typing", false);
    }

    if (files.length > 0) {
      await uploadSelectedImages(files);
      clearSelectedImages();
    }

    messageInput.focus();
    setStatus("");
  } catch (error) {
    setStatus(error.message || "Could not send message.", true);
  }
});

logoutButton.addEventListener("click", async () => {
  const response = await fetch(appUrl("/api/logout"), { method: "POST" });

  if (response.ok) {
    window.location.href = appUrl("/login.html");
    return;
  }

  setStatus("Could not log out.", true);
});

// --- Init ---

async function initializeChat() {
  try {
    await loadSession();
    await loadMessages();
    connectSocket();
  } catch (error) {
    setStatus(error.message || "Could not start chat.", true);
  }
}

initializeChat();
