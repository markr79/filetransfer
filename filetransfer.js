var async = require('async');
var WildEmitter = require('wildemitter');
var util = require('util');
var hashes = require('iana-hashes');

var fs = require('fs');
var each = require('lodash.foreach');
var uuid = require('node-uuid');
var path = require('path');
var utils = require('util');

function Sender(opts) {
  WildEmitter.call(this);
  var self = this;
  var options = opts || {};
  this.config = {
    chunksize: 16384,
    pacing: 10,
    hash: 'sha-1' // note: this uses iana hash names
  };
  // set our config from options
  each(options, function(item) {
    this.config[item] = options[item];
  });


  this.channel = null;
  this.hash = null;

  function toArrayBuffer(buffer) {
    var ab = new ArrayBuffer(buffer.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buffer.length; ++i) {
      view[i] = buffer[i];
    }
    return ab;
  }
  // paced sender
  // TODO: do we have to do this?
  this.processingQueue = async.queue(function(task, next) {
    var chunk = task.stream.read(task.size);
    /* Will return nill when size < remaining size */
    if (!chunk) {
      chunk = task.stream.read();
    }
    /* We are done */
    if (!chunk) {
      self.emit('progress', self.filename, self.stat.size, self.stat.size);
      self.emit('sentFile', self.filename, self.hash ? {
        hash: self.hash.digest('hex'),
        algo: self.config.hash
      } : null);
      next();
    } else {
      task.position += task.size;
      self.channel.send(toArrayBuffer(chunk));

      if (self.hash) {
        self.hash.update(new Uint8Array(chunk));
      }

      self.emit('progress', self.filename, task.position, self.stat.size);

      setTimeout(next, self.config.pacing); // pacing
      self.processingQueue.push(task);
    }
  });
}

util.inherits(Sender, WildEmitter);

Sender.prototype.send = function(file, channel) {
  this.filename = file;
  if (!this.filename) {
    throw new Error('No filename specified');
  }

  this.stat = fs.statSync(this.filename);
  this.channel = channel;

  if (this.config.hash) {
    this.hash = hashes.createHash(this.config.hash);
  }
  try {
    this.sendStream = fs.createReadStream(this.filename, {
      flags: this.config.flags || 'r',
      encoding: this.config.encoding || null,
      autoClose: true
    });
  } catch (e) {
    self.emit('sendError', {
      message: 'failed to open stream',
      error: e
    }, self.filename, self.metadata);
    console.error('Failed to open send stream', e);
  }

  this.sendStream.on('open', function() {
    this.processingQueue.push({
      totalSize: this.stat.size,
      stream: this.sendStream,
      position: 0,
      size: this.config.chunksize
    });
  });
}

function Receiver(opts) {
  WildEmitter.call(this);
  var self = this;

  var options = opts || {};
  this.config = {
    hash: 'sha-1'
  };
  // set our config from options
  each(options, function(item) {
    this.config[item] = options[item];
  });

  this.receiveBuffer = [];
  this.filepath = this.config.filepath || 'data/' + uuid.v4();
  /* Create path if needed */
  var dir = path.dirname(this.filepath);
  if (!fs.existsSync(dir)) {
    var elements = dir.split(path.sep);
    var createpath = '';
    each(elements, function(element) {
      createpath = path.join(createpath, element);
      if (!fs.existsSync(createpath)) {
        fs.mkdirSync(createpath);
      }
    });
  }

  try {
    this.receiveStream = fs.createWriteStream(this.filepath, {
      flags: this.config.flags || 'w',
      encoding: this.config.encoding || null,
      mode: this.config.mode || 0660
    });
  } catch (e) {
    self.emit('receiveError', {
      message: 'failed to open stream',
      error: e
    }, self.filename, self.metadata);
    console.error('Failed to open receive stream', e);
  }

  this.received = 0;
  this.metadata = {};
  this.channel = null;
  this.hash = null;
}
util.inherits(Receiver, WildEmitter);

Receiver.prototype.receive = function(metadata, channel) {
  var self = this;
  var basename = path.basename(self.filepath);
  if (metadata) {
    this.metadata = metadata;
  }
  if (this.config.hash) {
    this.hash = hashes.createHash(this.config.hash);
  }

  this.channel = channel;
  // chrome only supports arraybuffers and those make it easier to calc the hash
  this.channel.binaryType = 'arraybuffer';
  this.channel.onmessage = function(event) {
    if (!self.receiveStream) return;
    var len = event.data.byteLength;
    self.received += len;
    try {
      if (typeof data === 'string') {
        self.receiveStream.write(event.data);
      } else {
        self.receiveStream.write(new Buffer(new Uint8Array(event.data)));
      }
    } catch (e) {
      self.emit('receiveError', {
        message: 'write error',
        error: e
      }, basename, self.metadata);
      console.error('>>> Failed to write data', len, event, e);
    }

    if (self.hash) {
      self.hash.update(new Uint8Array(event.data));
    }

    if (self.received == self.metadata.size) {
      if (self.hash) {
        self.metadata.actualhash = self.hash.digest('hex');
      }
      // console.log('>>> file received', Blob);
      self.receiveStream.on('finish', function() {
        console.log('filetransfer: received file', self.filepath, self.metadata);
        self.emit('receivedFile', self.filepath, self.metadata);
      });

      self.receiveStream.end();
    } else if (self.received > self.metadata.size) {
      fs.unlinkSync(self.filepath)
      self.receiveStream.end();
      self.emit('receiveError', {
        message: 'received more than expected'
      }, basename, self.metadata);
      console.error('>>>> received more than expected, discarding...');
    } else {
      self.emit('progress', self.received, self.metadata.size);
    }
  };
};

module.exports = {};
module.exports.support = path && fs && fs.createWriteStream && fs.createReadStream;
module.exports.Sender = Sender;
module.exports.Receiver = Receiver;
