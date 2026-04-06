
const socket = io();

const appShell = document.getElementById("app-shell");
const welcomeScreen = document.getElementById("welcome-screen");
const welcomeForm = document.getElementById("welcome-form");
const authTitle = document.getElementById("auth-title");
const authToggle = document.getElementById("auth-toggle");
const usernameInput = document.getElementById("username-input");
const passwordInput = document.getElementById("password-input");
const passwordToggle = document.getElementById("password-toggle");

const sessionName = document.getElementById("session-name");
const connectionStatus = document.getElementById("connection-status");
const themeToggle = document.getElementById("theme-toggle");
const logoutButton = document.getElementById("logout-button");
const deleteAccountButton = document.getElementById("delete-account-button");

const groupList = document.getElementById("group-list");
const directList = document.getElementById("direct-list");
const discoverList = document.getElementById("discover-list");
const groupCount = document.getElementById("group-count");
const directCount = document.getElementById("direct-count");
const chatSearchInput = document.getElementById("chat-search-input");

const createGroupForm = document.getElementById("create-group-form");
const groupInput = document.getElementById("group-input");
const groupVisibility = document.getElementById("group-visibility");

const chatTypeLabel = document.getElementById("chat-type-label");
const chatTitle = document.getElementById("chat-title");
const chatSubtitle = document.getElementById("chat-subtitle");
const inviteLinkButton = document.getElementById("invite-link-button");
const messageSearchInput = document.getElementById("message-search-input");
const messages = document.getElementById("messages");

const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

const memberCount = document.getElementById("member-count");
const memberList = document.getElementById("member-list");
const addMemberForm = document.getElementById("add-member-form");
const addMemberInput = document.getElementById("add-member-input");
const requestList = document.getElementById("request-list");
const deleteGroupButton = document.getElementById("delete-group-button");

const roleForm = document.getElementById("role-form");
const roleUserInput = document.getElementById("role-user-input");
const roleSelect = document.getElementById("role-select");

const toast = document.getElementById("toast");
const mobileNavButtons = Array.from(document.querySelectorAll(".mobile-nav-button"));
const mobileChatMeta = document.getElementById("mobile-chat-meta");
const mobileInfoMeta = document.getElementById("mobile-info-meta");

let authMode = "signup";
let currentUser = {
  username: sessionStorage.getItem("chatx-username") || "",
  role: sessionStorage.getItem("chatx-role") || ""
};
let sidebarData = { user: null, groups: [], discover: [], directs: [] };
let currentChat = { type: "group", id: "general", isOwner: false };
let currentMembers = [];
let currentRequests = [];
let theme = localStorage.getItem("chatx-theme") || "light";
let unreadCounts = {};
let currentHistory = [];
let chatSearchTerm = "";
let messageSearchTerm = "";
let mobileView = "chat";

usernameInput.value = currentUser.username;
document.documentElement.setAttribute("data-theme", theme);
themeToggle.textContent = theme === "dark" ? "Light" : "Dark";

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24) || "Anonymous";
}

function normalizeGroupName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 24) || "general";
}

function formatLabel(value) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatLastSeen(timestamp) {
  if (!timestamp) {
    return "Last seen recently";
  }

  const date = new Date(timestamp);
  return `Last seen ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })}`;
}

function getTickInfo(message) {
  if (!message.status) {
    return { text: "", seen: false };
  }

  if (message.kind === "direct") {
    if (message.status.seen) {
      return { text: "\u2713\u2713", seen: true };
    }

    if (message.status.delivered) {
      return { text: "\u2713\u2713", seen: false };
    }

    return { text: "\u2713", seen: false };
  }

  const totalRecipients = Array.isArray(message.status.recipients) ? message.status.recipients.length : 0;
  const deliveredCount = Array.isArray(message.status.deliveredTo) ? message.status.deliveredTo.length : 0;
  const seenCount = Array.isArray(message.status.seenBy) ? message.status.seenBy.length : 0;

  if (totalRecipients > 0 && seenCount === totalRecipients) {
    return { text: "\u2713\u2713", seen: true };
  }

  if (totalRecipients > 0 && deliveredCount === totalRecipients) {
    return { text: "\u2713\u2713", seen: false };
  }

  return { text: "\u2713", seen: false };
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function chatKey(type, id) {
  return `${type}:${id}`;
}

function clearUnread(type, id) {
  unreadCounts[chatKey(type, id)] = 0;
}

function incrementUnread(type, id) {
  const key = chatKey(type, id);
  unreadCounts[key] = (unreadCounts[key] || 0) + 1;
}

function getUnread(type, id) {
  return unreadCounts[chatKey(type, id)] || 0;
}

function filterTextMatch(...values) {
  if (!chatSearchTerm) {
    return true;
  }

  const haystack = values.filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(chatSearchTerm);
}

function getInviteLink(groupName) {
  const url = new URL(window.location.href);
  url.searchParams.set("invite", groupName);
  return url.toString();
}

function isMobileViewport() {
  return window.innerWidth <= 800;
}

function setMobileView(nextView) {
  mobileView = nextView;

  if (appShell) {
    appShell.dataset.mobileView = isMobileViewport() ? nextView : "desktop";
  }

  mobileNavButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileView === nextView);
  });
}

function syncResponsiveLayout() {
  if (isMobileViewport()) {
    setMobileView(mobileView);
    return;
  }

  if (appShell) {
    appShell.dataset.mobileView = "desktop";
  }
}

function updateMobileNavCopy() {
  if (mobileChatMeta) {
    if (!currentUser.username) {
      mobileChatMeta.textContent = "Open a chat";
    } else if (currentChat.type === "group") {
      mobileChatMeta.textContent = formatLabel(currentChat.id || "general");
    } else {
      mobileChatMeta.textContent = currentChat.id || "Direct chat";
    }
  }

  if (mobileInfoMeta) {
    if (!currentUser.username) {
      mobileInfoMeta.textContent = "Members and account";
    } else if (currentChat.type === "group") {
      mobileInfoMeta.textContent = currentChat.isOwner ? "Owner controls" : "Members and roles";
    } else {
      mobileInfoMeta.textContent = currentUser.role === "admin" ? "Profile and admin" : "Profile and account";
    }
  }
}

function showLoggedOutState() {
  currentUser = { username: "", role: "" };
  sessionStorage.removeItem("chatx-username");
  sessionStorage.removeItem("chatx-role");
  unreadCounts = {};
  currentHistory = [];
  chatSearchTerm = "";
  messageSearchTerm = "";
  chatSearchInput.value = "";
  messageSearchInput.value = "";
  sidebarData = { user: null, groups: [], discover: [], directs: [] };
  currentChat = { type: "group", id: "general", isOwner: false };
  currentMembers = [];
  currentRequests = [];
  sessionName.textContent = "Logged out";
  connectionStatus.textContent = "Disconnected";
  logoutButton.classList.add("hidden");
  deleteAccountButton.classList.add("hidden");
  roleForm.classList.add("hidden");
  welcomeScreen.classList.remove("hidden");
  setMobileView("chat");
  updateMobileNavCopy();
  renderEmptyState("Log in or sign up to continue.");
  renderSidebar();
  renderMembers();
}

function renderEmptyState(text) {
  messages.innerHTML = `
    <div class="empty-state">
      <div>
        <h3>No messages yet</h3>
        <p>${text}</p>
      </div>
    </div>
  `;
}

function appendMessage(message) {
  const emptyState = messages.querySelector(".empty-state");

  if (emptyState) {
    messages.innerHTML = "";
  }

  const article = document.createElement("article");
  article.className = "message";
  article.dataset.messageId = message.id;

  if (message.kind === "system") {
    article.classList.add("message-system");
    article.textContent = message.text;
    messages.appendChild(article);
    messages.scrollTop = messages.scrollHeight;
    return;
  }

  if (message.from === currentUser.username) {
    article.classList.add("message-own");
  }

  const top = document.createElement("div");
  top.className = "message-top";

  const name = document.createElement("span");
  name.className = "message-name";
  name.textContent = message.from;

  const time = document.createElement("span");
  time.textContent = message.editedAt ? `${formatTime(message.timestamp)} (edited)` : formatTime(message.timestamp);

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = message.text;

  top.appendChild(name);
  top.appendChild(time);

  if (message.from === currentUser.username) {
    const tick = getTickInfo(message);
    const status = document.createElement("span");
    status.className = "message-status";
    status.textContent = tick.text;
    status.dataset.messageId = message.id;
    status.classList.toggle("seen", tick.seen);
    top.appendChild(status);
  }

  article.appendChild(top);
  article.appendChild(text);

  if (message.from === currentUser.username) {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "text-button";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => {
      const nextText = prompt("Edit your message:", message.text);

      if (!nextText || !nextText.trim()) {
        return;
      }

      socket.emit("edit message", {
        chatType: currentChat.type,
        chatId: currentChat.id,
        messageId: message.id,
        text: nextText.trim()
      });
    });

    actions.appendChild(editButton);
    article.appendChild(actions);
  }

  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
}

function replaceMessage(message) {
  const messageEl = messages.querySelector(`[data-message-id="${message.id}"]`);

  if (!messageEl) {
    return;
  }

  messageEl.remove();
  appendMessage(message);
}
function updateMessageStatus(messageId, status) {
  const statusEl = messages.querySelector(`[data-message-id="${messageId}"] .message-status, .message-status[data-message-id="${messageId}"]`);

  if (!statusEl) {
    return;
  }

  const tick = getTickInfo({ kind: currentChat.type === "direct" ? "direct" : "group", status });
  statusEl.textContent = tick.text;
  statusEl.classList.toggle("seen", tick.seen);
}

function renderHistory(history) {
  currentHistory = history.slice();
  const filteredHistory = messageSearchTerm
    ? history.filter((message) =>
        `${message.from || ""} ${message.text || ""}`.toLowerCase().includes(messageSearchTerm)
      )
    : history;

  messages.innerHTML = "";

  if (!filteredHistory.length) {
    renderEmptyState(messageSearchTerm ? "No messages match this search yet." : "Send the first message in this conversation.");
    return;
  }

  filteredHistory.forEach(appendMessage);
}

function createChatItem({ title, meta, active, onClick, badgeText }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-item";
  if (active) button.classList.add("active");

  const main = document.createElement("div");
  main.className = "chat-item-main";

  const itemTitle = document.createElement("div");
  itemTitle.className = "chat-item-title";
  itemTitle.textContent = title;

  const itemMeta = document.createElement("div");
  itemMeta.className = "chat-item-meta";
  itemMeta.textContent = meta;

  main.appendChild(itemTitle);
  main.appendChild(itemMeta);
  button.appendChild(main);

  if (badgeText) {
    const badge = document.createElement("span");
    badge.className = "chat-item-badge";
    badge.textContent = badgeText;
    button.appendChild(badge);
  }

  button.addEventListener("click", onClick);
  return button;
}

function renderSidebar() {
  groupList.innerHTML = "";
  directList.innerHTML = "";
  discoverList.innerHTML = "";

  const filteredGroups = (sidebarData.groups || []).filter((group) =>
    filterTextMatch(group.name, group.owner, group.visibility)
  );
  const filteredDirects = (sidebarData.directs || []).filter((direct) =>
    filterTextMatch(direct.username, direct.lastMessage && direct.lastMessage.text)
  );
  const filteredDiscover = (sidebarData.discover || []).filter((group) =>
    filterTextMatch(group.name, group.owner, group.visibility)
  );

  groupCount.textContent = String(filteredGroups.length || 0);
  directCount.textContent = String(filteredDirects.length || 0);

  filteredGroups.forEach((group) => {
    const groupBadge = getUnread("group", group.name) || group.requestCount;

    groupList.appendChild(
      createChatItem({
        title: formatLabel(group.name),
        meta: group.visibility === "private" ? `${group.memberCount} members` : "Public group",
        active: currentChat.type === "group" && currentChat.id === group.name,
        badgeText: groupBadge ? String(groupBadge) : "",
        onClick: () => socket.emit("open group", { group: group.name })
      })
    );
  });

  filteredDirects.forEach((direct) => {
    directList.appendChild(
      createChatItem({
        title: direct.username,
        meta: direct.online ? "Online" : formatLastSeen(direct.lastSeenAt),
        active: currentChat.type === "direct" && currentChat.id === direct.username,
        badgeText: getUnread("direct", direct.username) ? String(getUnread("direct", direct.username)) : "",
        onClick: () => socket.emit("open direct", { username: direct.username })
      })
    );
  });

  if (!filteredDiscover.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "No groups waiting here.";
    discoverList.appendChild(empty);
  } else {
    filteredDiscover.forEach((group) => {
      const wrapper = document.createElement("div");
      wrapper.className = "chat-item";

      const main = document.createElement("div");
      main.className = "chat-item-main";

      const title = document.createElement("div");
      title.className = "chat-item-title";
      title.textContent = formatLabel(group.name);

      const meta = document.createElement("div");
      meta.className = "chat-item-meta";
      meta.textContent = group.visibility === "private" ? "Private group" : "Public group";

      const action = document.createElement("button");
      action.type = "button";
      action.className = "discover-button";
      action.textContent = group.visibility === "private" ? (group.requested ? "Requested" : "Request") : "Join";
      action.addEventListener("click", () => {
        socket.emit("request group join", { group: group.name });
      });

      main.appendChild(title);
      main.appendChild(meta);
      wrapper.appendChild(main);
      wrapper.appendChild(action);
      discoverList.appendChild(wrapper);
    });
  }
}

function renderMembers() {
  memberList.innerHTML = "";
  requestList.innerHTML = "";

  const isGroupOwner = currentChat.type === "group" && currentChat.isOwner;
  addMemberForm.classList.toggle("hidden", !isGroupOwner);
  deleteGroupButton.classList.toggle("hidden", !(isGroupOwner && currentChat.id !== "general"));
  roleForm.classList.toggle("hidden", currentUser.role !== "admin");
  deleteAccountButton.classList.toggle("hidden", !currentUser.username);

  memberCount.textContent = String(currentMembers.length);

  if (!currentMembers.length) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "No member list for this chat.";
    memberList.appendChild(empty);
  } else {
    currentMembers.forEach((member) => {
      const item = document.createElement("li");
      item.className = "member-item";

      const left = document.createElement("div");
      left.className = "chat-item-main";

      const name = document.createElement("div");
      name.className = "chat-item-title";
      name.textContent = member.username === currentUser.username ? `${member.username} (You)` : member.username;

      const role = document.createElement("div");
      role.className = "member-role";
      role.textContent = `${member.role || "user"} - ${member.online ? "Online" : "Offline"}`;

      left.appendChild(name);
      left.appendChild(role);
      item.appendChild(left);

      if (isGroupOwner && member.username !== currentUser.username) {
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "secondary";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          socket.emit("remove group member", { group: currentChat.id, member: member.username });
        });
        item.appendChild(removeButton);
      }

      memberList.appendChild(item);
    });
  }

  if (isGroupOwner && currentRequests.length) {
    currentRequests.forEach((requestName) => {
      const item = document.createElement("div");
      item.className = "request-item";

      const name = document.createElement("div");
      name.className = "chat-item-title";
      name.textContent = requestName;

      const actions = document.createElement("div");
      actions.className = "request-actions";

      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Approve";
      approve.addEventListener("click", () => {
        socket.emit("review join request", { group: currentChat.id, member: requestName, action: "approve" });
      });

      const decline = document.createElement("button");
      decline.type = "button";
      decline.className = "secondary";
      decline.textContent = "Decline";
      decline.addEventListener("click", () => {
        socket.emit("review join request", { group: currentChat.id, member: requestName, action: "decline" });
      });

      actions.appendChild(approve);
      actions.appendChild(decline);
      item.appendChild(name);
      item.appendChild(actions);
      requestList.appendChild(item);
    });
  } else {
    requestList.innerHTML = `<div class="empty-note">No pending requests.</div>`;
  }
}

mobileNavButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setMobileView(button.dataset.mobileView || "chat");
  });
});

welcomeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const payload = {
    username: normalizeName(usernameInput.value),
    password: passwordInput.value
  };
  socket.emit(authMode, payload);
});

authToggle.addEventListener("click", () => {
  authMode = authMode === "signup" ? "login" : "signup";
  authTitle.textContent = authMode === "signup" ? "Start chatting" : "Welcome back";
  authToggle.textContent = authMode === "signup" ? "Switch to Login" : "Switch to Signup";
});

passwordToggle.addEventListener("click", () => {
  const isHidden = passwordInput.type === "password";
  passwordInput.type = isHidden ? "text" : "password";
  passwordToggle.textContent = isHidden ? "Hide" : "Show";
});

themeToggle.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("chatx-theme", theme);
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
});

logoutButton.addEventListener("click", () => socket.emit("logout"));
deleteAccountButton.addEventListener("click", () => socket.emit("delete account"));

createGroupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  socket.emit("create group", {
    group: normalizeGroupName(groupInput.value),
    visibility: groupVisibility.value
  });
  groupInput.value = "";
});

addMemberForm.addEventListener("submit", (event) => {
  event.preventDefault();
  socket.emit("add group member", {
    group: currentChat.id,
    member: normalizeName(addMemberInput.value)
  });
  addMemberInput.value = "";
});

deleteGroupButton.addEventListener("click", () => {
  socket.emit("delete group", { group: currentChat.id });
});

roleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  socket.emit("change user role", {
    username: normalizeName(roleUserInput.value),
    role: roleSelect.value
  });
  roleUserInput.value = "";
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("chat message", text);
  messageInput.value = "";
  messageInput.focus();
});

chatSearchInput.addEventListener("input", (event) => {
  chatSearchTerm = event.target.value.trim().toLowerCase();
  renderSidebar();
});

messageSearchInput.addEventListener("input", (event) => {
  messageSearchTerm = event.target.value.trim().toLowerCase();
  renderHistory(currentHistory);
});

inviteLinkButton.addEventListener("click", async () => {
  if (currentChat.type !== "group") {
    return;
  }

  const inviteLink = getInviteLink(currentChat.id);

  try {
    await navigator.clipboard.writeText(inviteLink);
    showToast("Invite link copied.");
  } catch (error) {
    showToast(inviteLink);
  }
});
socket.on("connect", () => {
  connectionStatus.textContent = "Connected";

  if (currentUser.username) {
    socket.emit("resume session", { username: currentUser.username });
  }
});

socket.on("disconnect", () => {
  connectionStatus.textContent = "Reconnecting...";
});

socket.on("auth success", ({ username, role }) => {
  currentUser = { username, role };
  sessionStorage.setItem("chatx-username", username);
  sessionStorage.setItem("chatx-role", role);
  sessionName.textContent = `${username} (${role})`;
  logoutButton.classList.remove("hidden");
  deleteAccountButton.classList.remove("hidden");
  welcomeScreen.classList.add("hidden");
  passwordInput.value = "";
  setMobileView("chat");
  updateMobileNavCopy();

  const inviteGroup = new URLSearchParams(window.location.search).get("invite");
  if (inviteGroup) {
    const cleanGroup = normalizeGroupName(inviteGroup);
    socket.emit("request group join", { group: cleanGroup });
    socket.emit("open group", { group: cleanGroup });
  }
});

socket.on("auth error", ({ text }) => {
  showToast(text);
});

socket.on("logged out", () => {
  showLoggedOutState();
});

socket.on("sidebar data", (payload) => {
  sidebarData = payload;

  if (payload.user) {
    currentUser.role = payload.user.role;
    sessionName.textContent = `${payload.user.username} (${payload.user.role})`;
  }

  renderSidebar();
  updateMobileNavCopy();

  if (currentChat.type === "direct") {
    const activeDirect = (sidebarData.directs || []).find((direct) => direct.username === currentChat.id);
    if (activeDirect) {
      chatSubtitle.textContent = activeDirect.online ? "Online now" : formatLastSeen(activeDirect.lastSeenAt);
    }
  }

  renderMembers();
});

socket.on("chat opened", (payload) => {
  currentChat = {
    type: payload.chatType,
    id: payload.chatId,
    isOwner: payload.isOwner
  };
  clearUnread(payload.chatType, payload.chatId);

  chatTypeLabel.textContent = payload.chatType === "direct" ? "Private chat" : "Group chat";
  chatTitle.textContent = payload.chatType === "group" ? formatLabel(payload.title) : payload.title;
  chatSubtitle.textContent =
    payload.chatType === "direct" && payload.presence
      ? payload.presence.online
        ? "Online now"
        : formatLastSeen(payload.presence.lastSeenAt)
      : payload.subtitle;

  messageInput.disabled = !payload.canChat;
  sendButton.disabled = !payload.canChat;
  inviteLinkButton.classList.toggle("hidden", payload.chatType !== "group");
  renderHistory(payload.history || []);
  setMobileView("chat");
  updateMobileNavCopy();

  if (payload.chatType === "direct") {
    currentMembers = [];
    currentRequests = [];
  }

  renderSidebar();
  renderMembers();
});

socket.on("group members", ({ group, owner, members, requests }) => {
  if (currentChat.type !== "group" || currentChat.id !== group) {
    return;
  }

  currentChat.isOwner = owner === currentUser.username || currentUser.role === "admin";
  currentMembers = members;
  currentRequests = requests;
  renderMembers();
});

socket.on("group access denied", ({ group, visibility, requested }) => {
  showToast(
    visibility === "private"
      ? requested
        ? `Join request already sent for ${group}.`
        : `You need approval to join ${group}.`
      : `You cannot access ${group}.`
  );
});

socket.on("group message", ({ group, message }) => {
  if (currentChat.type === "group" && currentChat.id === group) {
    appendMessage(message);
  } else if (message.from !== currentUser.username) {
    incrementUnread("group", group);
    renderSidebar();
  }
});

socket.on("direct message", ({ username: otherUser, message }) => {
  if (currentChat.type === "direct" && currentChat.id === otherUser) {
    appendMessage(message);
  } else if (message.from !== currentUser.username) {
    incrementUnread("direct", otherUser);
    renderSidebar();
  }
});

socket.on("group status update", ({ group, messageId, status }) => {
  if (currentChat.type === "group" && currentChat.id === group) {
    updateMessageStatus(messageId, status);
  }
});

socket.on("direct status update", ({ username: otherUser, messageId, status }) => {
  if (currentChat.type === "direct" && currentChat.id === otherUser) {
    updateMessageStatus(messageId, status);
  }
});

socket.on("message edited", ({ chatType, chatId, message }) => {
  if (currentChat.type === chatType && currentChat.id === chatId) {
    replaceMessage(message);
  }
});

socket.on("group deleted", ({ group }) => {
  if (currentChat.type === "group" && currentChat.id === group) {
    socket.emit("open group", { group: "general" });
  }
});

socket.on("toast", ({ text }) => {
  showToast(text);
});

window.addEventListener("load", () => {
  const params = new URLSearchParams(window.location.search);
  const inviteGroup = params.get("invite");

  if (!inviteGroup) {
    return;
  }

  const cleanGroup = normalizeGroupName(inviteGroup);
  const tryJoinInvite = () => {
    socket.emit("request group join", { group: cleanGroup });
    socket.emit("open group", { group: cleanGroup });
  };

  if (currentUser.username) {
    setTimeout(tryJoinInvite, 500);
  } else {
    showToast(`Log in, then open invite group: ${cleanGroup}`);
  }
});

window.addEventListener("resize", syncResponsiveLayout);

if (!currentUser.username) {
  setMobileView("chat");
  updateMobileNavCopy();
  renderEmptyState("Log in or sign up to continue.");
  renderMembers();
} else {
  sessionName.textContent = `${currentUser.username}${currentUser.role ? ` (${currentUser.role})` : ""}`;
  welcomeScreen.classList.add("hidden");
  logoutButton.classList.remove("hidden");
  deleteAccountButton.classList.remove("hidden");
  connectionStatus.textContent = "Reconnecting...";
  setMobileView("chat");
  updateMobileNavCopy();
  renderEmptyState("Restoring your chats...");
  renderMembers();
}

syncResponsiveLayout();
