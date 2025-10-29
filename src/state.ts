/**
 * 全局狀態管理。
 */
const state = {
    convByVar: (langDict) => "繁簡轉換未初始化！",  // 簡繁轉換
    articleTitle: '', // 當前條目標題
    inTalkPage: false, // 是否在Talk名字空間
    assessmentType: '', // 評級類型
    userName: '', // 用戶名
};

export default state;