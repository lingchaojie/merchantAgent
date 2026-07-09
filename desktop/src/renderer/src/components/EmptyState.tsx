import { IconSparkle } from "./icons";

// Example prompts double as onboarding + a demo of "same question, different
// permissions" — try SO-1001 利润 as 销售 (denied) vs 经理 (allowed).
const EXAMPLES = [
  "SO-1001 进度怎么样",
  "SO-1001 齐套了吗",
  "SO-1001 的利润多少",
  "SO-1002 交期是什么时候",
];

export function EmptyState({ onPick }: { onPick: (q: string) => void }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark"><IconSparkle width={22} height={22} /></div>
      <h1 className="empty-title">问点什么</h1>
      <p className="empty-sub">
        连接你的企业系统，按职位提问。结果随你的身份权限自动变化——
        换个身份问同一个问题试试。
      </p>
      <div className="chips">
        {EXAMPLES.map((e) => (
          <button key={e} className="chip" onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
