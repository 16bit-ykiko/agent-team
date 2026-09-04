import type { AgentInfo } from "./useServer";

export function isImageAvatar(avatar: string): boolean {
  return (
    avatar.includes("/") ||
    avatar.endsWith(".jpg") ||
    avatar.endsWith(".png") ||
    avatar.endsWith(".webp")
  );
}

export function Avatar({
  avatar,
  color,
  name,
  size = 28,
  title,
}: {
  avatar: string;
  color: string;
  name: string;
  size?: number;
  title?: string;
}) {
  const isImg = isImageAvatar(avatar);
  return (
    <div
      className="agent-avatar"
      style={{
        width: size,
        height: size,
        background: isImg ? "transparent" : color,
        fontSize: size * 0.5,
      }}
      title={title ?? name}
    >
      {isImg ? (
        <img
          src={avatar}
          alt={name}
          style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
        />
      ) : (
        avatar
      )}
    </div>
  );
}

export function AgentAvatar({ agent, size = 28 }: { agent: AgentInfo; size?: number }) {
  return (
    <Avatar
      avatar={agent.avatar}
      color={agent.color}
      name={agent.name}
      size={size}
      title={`${agent.name} (${agent.model})`}
    />
  );
}
