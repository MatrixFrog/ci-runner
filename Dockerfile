FROM google/nodejs

WORKDIR /app
ADD package.json /app/
RUN npm install -g grunt-cli bower
RUN npm install
ADD . /app

CMD []
ENTRYPOINT ["/nodejs/bin/node", "server"]