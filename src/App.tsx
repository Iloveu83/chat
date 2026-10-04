import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DataConnection } from "peerjs";
import { Peer } from "peerjs";

type User = {
  id: string;
  username: string;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  sentAt: number;
  type: "text" | "image" | "audio";
  text?: string;
  mediaUrl?: string;
};

type NetworkPacket =
  | { kind: "intro"; user: User }
  | { kind: "peer-list"; peers: User[] }
  | { kind: "chat-text"; messageId: string; sender: User; sentAt: number; text: string }
  | { kind: "chat-image"; messageId: string; sender: User; sentAt: number; blob: Blob }
  | { kind: "chat-audio"; messageId: string; sender: User; sentAt: number; blob: Blob };

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const roomToHostId = (roomCode: string) =>
  `ramchat-${roomCode.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

const formatTime = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);

async function compressImage(file: File): Promise<Blob> {
  const maxUploadSize = 8 * 1024 * 1024;

  if (file.size > maxUploadSize) {
    throw new Error("Image is too large");
  }

  const imageBitmap = await createImageBitmap(file);
  const maxSide = 1280;
  const ratio = Math.min(1, maxSide / Math.max(imageBitmap.width, imageBitmap.height));
  const width = Math.max(1, Math.round(imageBitmap.width * ratio));
  const height = Math.max(1, Math.round(imageBitmap.height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    imageBitmap.close();
    throw new Error("Could not process image");
  }

  context.drawImage(imageBitmap, 0, 0, width, height);
  imageBitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Image compression failed"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      0.78
    );
  });
}

export default function App() {
  const [usernameInput, setUsernameInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [isJoined, setIsJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [myUser, setMyUser] = useState<User | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Enter a username and room code to start.");
  const [joinError, setJoinError] = useState("");
  const [networkReady, setNetworkReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const myUserRef = useRef<User | null>(null);
  const roomCodeRef = useRef("");
  const usersRef = useRef<Record<string, string>>({});
  const connectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const hostConnectionRef = useRef<DataConnection | null>(null);
  const connectedPeersRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isHostRef = useRef(false);

  const sortedUsers = useMemo(
    () =>
      Object.entries(users)
        .map(([id, username]) => ({ id, username }))
        .sort((a, b) => a.username.localeCompare(b.username)),
    [users]
  );

  const publishUsers = (nextUsers: Record<string, string>) => {
    usersRef.current = nextUsers;
    setUsers(nextUsers);
  };

  const upsertUser = (user: User) => {
    if (!user.id || !user.username) {
      return;
    }

    publishUsers({
      ...usersRef.current,
      [user.id]: user.username,
    });
  };

  const syncUsers = (peerUsers: User[]) => {
    const nextUsers: Record<string, string> = {};

    peerUsers.forEach((user) => {
      if (user.id && user.username) {
        nextUsers[user.id] = user.username;
      }
    });

    const self = myUserRef.current;
    if (self) {
      nextUsers[self.id] = self.username;
    }

    publishUsers(nextUsers);
  };

  const removeUser = (peerId: string) => {
    if (!usersRef.current[peerId]) {
      return;
    }

    const nextUsers = { ...usersRef.current };
    delete nextUsers[peerId];
    publishUsers(nextUsers);
  };

  const rememberObjectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  };

  const addMessage = (message: ChatMessage) => {
    setMessages((current) => {
      if (current.some((existing) => existing.id === message.id)) {
        return current;
      }
      return [...current, message];
    });
  };

  const cleanupRecorder = () => {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }

    recorderRef.current = null;

    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
    }

    setIsRecording(false);
  };

  const broadcast = (packet: NetworkPacket, exceptPeerId?: string) => {
    connectionsRef.current.forEach((connection) => {
      if (connection.peer !== exceptPeerId && connection.open) {
        connection.send(packet);
      }
    });
  };

  const broadcastUserList = (exceptPeerId?: string) => {
    if (!isHostRef.current) {
      return;
    }

    const peers = Object.entries(usersRef.current).map(([id, username]) => ({
      id,
      username,
    }));

    broadcast({ kind: "peer-list", peers }, exceptPeerId);
  };

  const handleDisconnect = (peerId: string) => {
    connectionsRef.current.delete(peerId);
    connectedPeersRef.current.delete(peerId);

    if (hostConnectionRef.current?.peer === peerId) {
      hostConnectionRef.current = null;
      setNetworkReady(false);
      setStatus("Room host disconnected. Rejoin the room to continue.");
      removeUser(peerId);
      return;
    }

    removeUser(peerId);

    if (isHostRef.current) {
      broadcastUserList();
      setStatus(
        connectedPeersRef.current.size > 0
          ? `Hosting ${roomCodeRef.current}. ${connectedPeersRef.current.size} peer(s) connected.`
          : `Hosting ${roomCodeRef.current}. Waiting for peers...`
      );
    }
  };

  const handlePacket = (sourcePeerId: string, packet: NetworkPacket) => {
    if (!packet || typeof packet.kind !== "string") {
      return;
    }

    if (packet.kind === "intro") {
      upsertUser(packet.user);

      if (isHostRef.current) {
        const peers = Object.entries(usersRef.current).map(([id, username]) => ({
          id,
          username,
        }));

        const connection = connectionsRef.current.get(sourcePeerId);
        if (connection?.open) {
          connection.send({ kind: "peer-list", peers });
        }

        // Tell everyone else that the room membership changed.
        broadcastUserList(sourcePeerId);

        setStatus(
          `Hosting ${roomCodeRef.current}. ${connectedPeersRef.current.size} peer(s) connected.`
        );
      }

      return;
    }

    if (packet.kind === "peer-list") {
      // Guests use the host as the single room connection.
      // This avoids fragile guest-to-guest mesh discovery.
      syncUsers(packet.peers);
      return;
    }

    if (
      packet.kind === "chat-text" ||
      packet.kind === "chat-image" ||
      packet.kind === "chat-audio"
    ) {
      // Host relays once; every client ignores a packet it has already seen.
      if (seenMessageIdsRef.current.has(packet.messageId)) {
        return;
      }

      seenMessageIdsRef.current.add(packet.messageId);

      if (packet.kind === "chat-text") {
        addMessage({
          id: packet.messageId,
          senderId: packet.sender.id,
          senderName: packet.sender.username,
          sentAt: packet.sentAt,
          type: "text",
          text: packet.text,
        });
      } else if (packet.kind === "chat-image") {
        addMessage({
          id: packet.messageId,
          senderId: packet.sender.id,
          senderName: packet.sender.username,
          sentAt: packet.sentAt,
          type: "image",
          mediaUrl: rememberObjectUrl(packet.blob),
        });
      } else {
        addMessage({
          id: packet.messageId,
          senderId: packet.sender.id,
          senderName: packet.sender.username,
          sentAt: packet.sentAt,
          type: "audio",
          mediaUrl: rememberObjectUrl(packet.blob),
        });
      }

      if (isHostRef.current) {
        broadcast(packet, sourcePeerId);
      }

      return;
    }
  };

  const registerConnection = (connection: DataConnection) => {
    const existing = connectionsRef.current.get(connection.peer);

    if (existing && existing !== connection) {
      existing.close();
      connectionsRef.current.delete(connection.peer);
    }

    if (connectionsRef.current.has(connection.peer)) {
      return;
    }

    connectionsRef.current.set(connection.peer, connection);

    connection.on("open", () => {
      connectedPeersRef.current.add(connection.peer);

      if (myUserRef.current) {
        connection.send({ kind: "intro", user: myUserRef.current });
      }

      if (hostConnectionRef.current?.peer === connection.peer) {
        setNetworkReady(true);
        setStatus(`Connected to room ${roomCodeRef.current}.`);
      } else if (isHostRef.current) {
        setNetworkReady(true);
        setStatus(
          `Hosting ${roomCodeRef.current}. ${connectedPeersRef.current.size} peer(s) connected.`
        );
      }
    });

    connection.on("data", (data) => {
      handlePacket(connection.peer, data as NetworkPacket);
    });

    connection.on("close", () => {
      handleDisconnect(connection.peer);
    });

    connection.on("error", () => {
      handleDisconnect(connection.peer);
    });
  };

  const waitForPeerOpen = (peer: Peer) =>
    new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("Connection timed out"));
      }, 10000);

      peer.once("open", (id) => {
        window.clearTimeout(timeout);
        resolve(id);
      });

      peer.once("error", (error) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Peer setup failed"));
      });
    });

  const setupPeerListeners = (peer: Peer) => {
    peer.on("connection", (connection) => {
      registerConnection(connection);
    });

    peer.on("disconnected", () => {
      setNetworkReady(false);
      setStatus("Network interrupted. Trying to reconnect...");
      peer.reconnect();
    });

    peer.on("error", () => {
      setStatus("Peer network error. Try rejoining the room.");
    });
  };

  const handleJoin = async () => {
    const username = usernameInput.trim();
    const roomCode = roomInput.trim().toLowerCase();

    if (!username || username.length < 2) {
      setJoinError("Username must be at least 2 characters.");
      return;
    }

    if (!roomCode || roomCode.length < 3) {
      setJoinError("Room code must be at least 3 characters.");
      return;
    }

    setJoinError("");
    setStatus("Connecting...");

    const hostId = roomToHostId(roomCode);

    try {
      const hostPeer = new Peer(hostId);
      const openedHostId = await waitForPeerOpen(hostPeer);

      peerRef.current = hostPeer;
      setupPeerListeners(hostPeer);

      const selfUser: User = { id: openedHostId, username };
      myUserRef.current = selfUser;
      setMyUser(selfUser);
      upsertUser(selfUser);

      roomCodeRef.current = roomCode;
      isHostRef.current = true;
      setIsHost(true);
      setNetworkReady(true);
      setIsJoined(true);
      setStatus(`Hosting room ${roomCode}. Share the room code to invite others.`);
    } catch (error) {
      // The host-ID attempt failed. Destroy it before falling back to a guest peer.
      hostPeer.destroy();

      const typedError = error as { type?: string; message?: string };

      if (typedError?.type !== "unavailable-id") {
        setJoinError(typedError?.message || "Unable to create room host connection.");
        setStatus("Could not connect.");
        return;
      }

      try {
        const guestPeer = new Peer();
        const guestId = await waitForPeerOpen(guestPeer);

        peerRef.current = guestPeer;
        setupPeerListeners(guestPeer);

        const selfUser: User = { id: guestId, username };
        myUserRef.current = selfUser;
        setMyUser(selfUser);
        upsertUser(selfUser);

        roomCodeRef.current = roomCode;
        isHostRef.current = false;
        setIsHost(false);
        setNetworkReady(false);
        setIsJoined(true);

        const hostConnection = guestPeer.connect(hostId, { reliable: true });
        hostConnectionRef.current = hostConnection;
        registerConnection(hostConnection);

        setStatus(`Joining room ${roomCode}...`);
      } catch (guestError) {
        const typedGuestError = guestError as { message?: string };
        setJoinError(typedGuestError?.message || "Unable to join room.");
        setStatus("Could not connect.");
      }
    }
  };

  const handleSendText = () => {
    if (!myUser || !networkReady) {
      return;
    }

    const text = draft.trim();
    if (!text) {
      return;
    }

    const sentAt = Date.now();
    const messageId = createId();
    const packet: NetworkPacket = {
      kind: "chat-text",
      messageId,
      sender: myUser,
      sentAt,
      text,
    };

    seenMessageIdsRef.current.add(messageId);

    addMessage({
      id: messageId,
      senderId: myUser.id,
      senderName: myUser.username,
      sentAt,
      type: "text",
      text,
    });

    broadcast(packet);
    setDraft("");
  };

  const handleImageUpload = async (file: File | undefined) => {
    if (!file || !myUser || !networkReady) {
      return;
    }

    try {
      const blob = await compressImage(file);
      const sentAt = Date.now();
      const messageId = createId();

      const packet: NetworkPacket = {
        kind: "chat-image",
        messageId,
        sender: myUser,
        sentAt,
        blob,
      };

      seenMessageIdsRef.current.add(messageId);

      addMessage({
        id: messageId,
        senderId: myUser.id,
        senderName: myUser.username,
        sentAt,
        type: "image",
        mediaUrl: rememberObjectUrl(blob),
      });

      broadcast(packet);
    } catch {
      setStatus("Could not process image. Keep it under 8 MB and try again.");
    }
  };

  const toggleRecording = async () => {
    if (!myUser || !networkReady) {
      return;
    }

    if (isRecording) {
      recorderRef.current?.stop();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });

        if (blob.size > 0 && myUserRef.current && networkReady) {
          const currentUser = myUserRef.current;
          const sentAt = Date.now();
          const messageId = createId();

          const packet: NetworkPacket = {
            kind: "chat-audio",
            messageId,
            sender: currentUser,
            sentAt,
            blob,
          };

          seenMessageIdsRef.current.add(messageId);

          addMessage({
            id: messageId,
            senderId: currentUser.id,
            senderName: currentUser.username,
            sentAt,
            type: "audio",
            mediaUrl: rememberObjectUrl(blob),
          });

          broadcast(packet);
        }

        cleanupRecorder();
      };

      recorderRef.current = recorder;
      setIsRecording(true);
      recorder.start();

      recordingTimerRef.current = window.setTimeout(() => {
        recorderRef.current?.stop();
      }, 60_000);
    } catch {
      setStatus("Microphone permission is required to record audio notes.");
      cleanupRecorder();
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      cleanupRecorder();

      connectionsRef.current.forEach((connection) => connection.close());
      connectionsRef.current.clear();

      peerRef.current?.destroy();

      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    };
  }, []);

  const canSend = isJoined && networkReady && !!myUser;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AnimatePresence>
        {!isJoined && (
          <motion.div
            className="fixed inset-0 z-20 flex items-center justify-center bg-zinc-950/95 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="w-full max-w-md border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/30"
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-400">RAM Chat</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">Live P2P Workspace</h1>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Nothing is stored in the app. Refreshing or closing the tab clears the room state
                and chat history.
              </p>

              <div className="mt-6 space-y-3">
                <label className="block text-sm text-zinc-300">
                  Username
                  <input
                    value={usernameInput}
                    onChange={(event) => setUsernameInput(event.target.value)}
                    className="mt-1 w-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none transition focus:border-indigo-400"
                    placeholder="Your name"
                    maxLength={24}
                    autoComplete="off"
                  />
                </label>

                <label className="block text-sm text-zinc-300">
                  Room code
                  <input
                    value={roomInput}
                    onChange={(event) => setRoomInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleJoin();
                      }
                    }}
                    className="mt-1 w-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none transition focus:border-indigo-400"
                    placeholder="team-sync"
                    maxLength={32}
                    autoComplete="off"
                  />
                </label>
              </div>

              {joinError && <p className="mt-3 text-sm text-rose-300">{joinError}</p>}

              <button
                onClick={handleJoin}
                className="mt-6 w-full border border-indigo-500 bg-indigo-500/10 px-4 py-2 text-sm font-semibold text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Join Room
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="mx-auto flex h-screen w-full max-w-[1300px] flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 md:px-6">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">RAM Chat</p>
            <h2 className="mt-1 text-lg font-semibold text-zinc-100">
              {roomCodeRef.current || "No Room"}
            </h2>
          </div>

          <div className="text-right text-sm text-zinc-400">
            <div className="flex items-center justify-end gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  networkReady ? "bg-emerald-400" : "bg-rose-400"
                }`}
              />
              <p>{isHost ? "Host" : "Peer"}</p>
            </div>
            <p className="max-w-[28rem] text-xs text-zinc-500">{networkReady ? status : "Not connected"}</p>
          </div>
        </header>

        <section className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="max-h-44 overflow-y-auto border-b border-zinc-800 px-4 py-4 md:max-h-none md:w-72 md:border-b-0 md:border-r md:px-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-400">
                Active Users
              </h3>
              <span className="text-xs text-zinc-600">{sortedUsers.length}</span>
            </div>

            <motion.ul layout className="mt-3 space-y-2 text-sm">
              {sortedUsers.map((user) => (
                <motion.li
                  layout
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  key={user.id}
                  className="flex items-center justify-between border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                >
                  <span className="truncate">{user.username}</span>
                  {myUser?.id === user.id && <span className="ml-2 text-xs text-indigo-300">you</span>}
                </motion.li>
              ))}
            </motion.ul>
          </aside>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div>
                    <p className="text-sm text-zinc-400">No messages yet.</p>
                    <p className="mt-1 text-xs text-zinc-600">
                      Send a message, image, or voice note to start.
                    </p>
                  </div>
                </div>
              ) : (
                <motion.ul layout className="space-y-4">
                  {messages.map((message) => {
                    const isMine = myUser?.id === message.senderId;

                    return (
                      <motion.li
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        key={message.id}
                        className={`flex ${isMine ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[92%] border px-3 py-2 md:max-w-[70%] ${
                            isMine
                              ? "border-indigo-500/40 bg-indigo-500/10"
                              : "border-zinc-800 bg-zinc-900/70"
                          }`}
                        >
                          <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
                            <span>{message.senderName}</span>
                            <span>{formatTime(message.sentAt)}</span>
                          </div>

                          {message.type === "text" && (
                            <p className="whitespace-pre-wrap break-words text-sm leading-6">
                              {message.text}
                            </p>
                          )}

                          {message.type === "image" && message.mediaUrl && (
                            <img
                              src={message.mediaUrl}
                              alt={`Image from ${message.senderName}`}
                              loading="lazy"
                              className="max-h-96 w-full border border-zinc-800 object-contain"
                            />
                          )}

                          {message.type === "audio" && message.mediaUrl && (
                            <audio src={message.mediaUrl} controls className="w-full" />
                          )}
                        </div>
                      </motion.li>
                    );
                  })}
                </motion.ul>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-zinc-800 px-4 py-3 md:px-6">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSendText();
                    }
                  }}
                  placeholder={canSend ? "Type a message..." : "Waiting for connection..."}
                  disabled={!canSend}
                  className="min-w-[220px] flex-1 border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                />

                <button
                  onClick={handleSendText}
                  disabled={!canSend || !draft.trim()}
                  className="border border-indigo-500 px-3 py-2 text-sm text-indigo-200 transition hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Send
                </button>

                <label
                  className={`border border-zinc-700 px-3 py-2 text-sm text-zinc-200 transition ${
                    canSend
                      ? "cursor-pointer hover:bg-zinc-800/70"
                      : "cursor-not-allowed opacity-40"
                  }`}
                >
                  Image
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={!canSend}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      void handleImageUpload(file);
                      event.target.value = "";
                    }}
                  />
                </label>

                <button
                  onClick={() => void toggleRecording()}
                  disabled={!canSend}
                  className={`border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    isRecording
                      ? "border-rose-400 bg-rose-500/15 text-rose-200"
                      : "border-zinc-700 text-zinc-200 hover:bg-zinc-800/70"
                  }`}
                >
                  {isRecording ? "Stop Recording" : "Record Voice"}
                </button>
              </div>

              <p className="mt-2 text-xs text-zinc-600">
                Shift+Enter is reserved for multiline text. Voice notes automatically stop after
                60 seconds.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
