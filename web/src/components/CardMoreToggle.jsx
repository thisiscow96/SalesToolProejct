// 휴대폰 카드형 목록(T-206)의 '자세히/접기' 스위치 — 상태를 React에 두지 않는 체크박스(CSS :has 로 펼침).
// 넓은 화면(표)에서는 이 칸이 숨겨진다. 업무 데이터·로직과 무관한 화면 전용 요소.
export default function CardMoreToggle() {
  return (
    <label className="main-card-more-btn">
      <input type="checkbox" className="main-card-more-input" />
      <span className="main-card-more-open">자세히</span>
      <span className="main-card-more-close">접기</span>
    </label>
  );
}
