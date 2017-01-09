module.exports = archae => ({
  mount() {
    const element = (() => {
      const element = document.createElement('form');

      const textLabel = document.createElement('label');
      textLabel.innerHTML = 'Input text: ';
      textLabel.style.marginRight = '10px';
      const text = document.createElement('input');
      text.type = 'text';
      text.placeholder = 'Enter some text';
      text.autofocus = true;
      textLabel.appendChild(text);
      element.appendChild(textLabel);

      const numberLabel = document.createElement('label');
      numberLabel.innerHTML = 'Padding: ';
      const number = document.createElement('input');
      number.type = 'number';
      number.value = 10;
      numberLabel.appendChild(number);
      element.appendChild(numberLabel);

      const submit = document.createElement('input');
      submit.type = 'submit';
      submit.value = 'Left-pad it on the server!';
      submit.style.display = 'block';
      submit.style.margin = '10px 0';
      element.appendChild(submit);

      const result = document.createElement('textarea');
      result.style.width = '400px';
      result.style.height = '200px';
      element.appendChild(result);

      element.addEventListener('submit', e => {
        fetch('/left-pad', {
          method: 'POST',
          headers: {
            'left-pad': number.value,
          },
          body: text.value,
        })
          .then(res => res.text()
            .then(s => {
              result.value = s;
            })
          )
          .catch(err => {
            console.warn(err);
          });

        e.preventDefault();
      });

      return element;
    })();
    this.element = element;

    document.body.appendChild(element);
  },
  unmount() {
    document.body.removeChild(this.element);
  }
});
