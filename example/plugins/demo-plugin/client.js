module.exports = archae => ({
  mount() {
    let message = 'Running in the browser!';
    let n = 0;
    const _updateText = () => {
      element.textContent = message + ' You clicked ' + n + ' times.';
    };

    const element = document.createElement('h1');
    element.onclick = () => {
      n++;
      _updateText();
    };
    this.element = element;
    document.body.appendChild(element);

    return {
      changeMessage(m) {
        message = m;
        _updateText();
      }
    };
  },
  unmount() {
    document.body.removeChild(this.element);
  }
});
