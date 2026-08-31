import "./style.css";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // window.zunia provider will be injected here
  },
});
