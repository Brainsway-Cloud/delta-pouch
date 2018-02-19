'use strict';

var Promise = require('bluebird');

var events = require('events');

function empty(obj) {
  for (var i in obj) { // jshint unused:false
    return false;
  }
  return true;
}

function isString(obj) {
  return typeof obj === 'string' || obj instanceof String;
}

function isNumeric(obj) {
  return !isNaN(obj);
}

function notDefined(obj) {
  return typeof obj === 'undefined';
}

exports.delta = new events.EventEmitter();

exports.deltaInit = function () {

  // TODO: remove as not needed anymore, right?
  // this.on('created', function (object) {
  //   onCreate(this, object);
  // });

  this.on('destroyed', function () {
    onDestroyed(this);
  });
};

exports.clone = function (obj) {
  return JSON.parse(JSON.stringify(obj));
};

exports.merge = function (obj1, obj2) {
  var merged = {};
  for (var i in obj1) {
    merged[i] = obj1[i];
  }
  for (i in obj2) {
    merged[i] = obj2[i];
  }
  return merged;
};

function save(db, doc) {
  delete(doc._rev); // delete any revision numbers copied from previous docs
  doc.$createdAt = (new Date()).toJSON();
  if (doc.$id) { // update?
    // this format guarantees the docs will be retrieved in order they were created
    doc._id = doc.$id + '.' + doc.$createdAt;

    return db.put(doc).then(function (response) {
      response.$id = doc.$id;
      onCreate(db, response);
      return response;
    }).catch(/* istanbul ignore next */ function (err) {
      // It appears there is a bug in pouch that causes a doc conflict even though we are creating a
      // new doc
      if (err.status !== 409) {
        throw err;
      }
    });
  } else { // new
    doc.$id  = doc._id
    doc._id += '.' + doc.$createdAt;
    return db.post(doc).then(function (response) {
      onCreate(db, { id: response.$id });
      return response;
    });
  }
}

exports.save = function (doc) {
  return save(this, doc);
};

exports.delete = function (docOrId) {
  var id = isString(docOrId) || isNumeric(docOrId) ? docOrId : docOrId.$id;
  if (notDefined(id)) {
    throw new Error('missing $id');
  }
  return save(this, {$id: id, $deleted: true});
};

function deleteConflicts2(db, doc) {
  return db
    .get(doc._id, {
      open_revs: doc._conflicts
    })
    .then(function(docs) {
      docs.rows.forEach(function (el) { 
        el._deleted = true;
      });
      return docs;
    });
    .then(function(docs) {
      db.bulkDocs(docs);
    };   
  }
    
function deleteConflicts(db, id) { 
  db.get(id, {conflicts: true}).then(function (doc) {
    // do something with the doc
    if (doc._conflicts) {
        deleteConflicts2(db, doc);
      });
    }
  }).catch(function (err) {
    // handle any errors
  });
}

// rebuild the document from the delta changes in order of time
exports.rebuildDoc = function (id) {
  var db = this;
  var outDoc = {},
    deletions = {};
  var options = { include_docs: true, startkey : id + ".2018", endkey : id + ".9999" };
                 
  return db.allDocs(options).then(function (doc) {
    doc.rows.forEach(function (el) { // itterate the documents
      if (!el.doc.$id) { 
        console.log("Missing $id attribute?");
        assert(false);
      }
      if (el.doc.$deleted) { 
        outDoc = null;
      } else {
        if (outDoc) { // exists?
          outDoc = exports.merge(outDoc, el.doc);
        } else {
          outDoc = el.doc;
        }
      }
    });
    return outDoc;
  });
};

exports.__all = function () {
  var db = this;
  var docs = {},
    deletions = {};
  var options = { include_docs: true };
                 
  return db.allDocs(options).then(function (doc) {
    doc.rows.forEach(function (el) {
      if (!el.doc.$id) { // first delta for doc?
        el.doc.$id = el.doc._id;
      }
      if (el.doc.$deleted) { // deleted?
        delete(docs[el.doc.$id]);
        deletions[el.doc.$id] = true;
      } else if (!deletions[el.doc.$id]) { // update before any deletion?
        if (docs[el.doc.$id]) { // exists?
          docs[el.doc.$id] = exports.merge(docs[el.doc.$id], el.doc);
        } else {
          docs[el.doc.$id] = el.doc;
        }
      }
    });
    return docs;
  });
};

var deletions = {};

exports.wasDeleted = function (id) {
  return deletions[id] ? true : false;
};

exports.markDeletion = function (id) {
  deletions[id] = true;
};

function onCreate(db, object) {
  db.get(object.id).then(function (doc) {
    var id = doc.$id ? doc.$id : doc._id;
    if (!exports.wasDeleted(id)) { // not previously deleted?
      if (doc.$deleted) { // deleted?
        exports.markDeletion(id);
        exports.delta.emit('delete', id);
      } else if (doc.$id) { // update?
        exports.delta.emit('update', doc);
      } else {
        doc.$id = id;
        exports.delta.emit('create', doc);
      }
    }
  });
}

function onDestroyed(db) {
  db.delta.removeAllListeners();
}

function getChanges(oldDoc, newDoc) {
  var changes = {}, change = false;
  for (var i in newDoc) {
    if (oldDoc[i] !== newDoc[i]) {
      change = true;
      changes[i] = newDoc[i];
    }
  }
  return change ? changes : null;
}

exports.saveChanges = function (oldDoc, newDoc) {
  var db = this, changes = getChanges(oldDoc, newDoc);
  if (changes !== null) {
    changes.$id = oldDoc.$id;
    return db.save(changes).then(function () {
      return changes;
    });
  }
  return Promise.resolve();
};

function getAndRemove(db, id) {
  return db.get(id).then(function (object) {
    return db.remove(object);
  }).catch(function (err) {
    // If the doc isn't found, no biggie. Else throw.
    /* istanbul ignore if */
    if (err.status !== 404) {
      throw err;
    }
  });
}

exports.getAndRemove = function (id) {
  return getAndRemove(this, id);
};

/*
 * We need a second pass for deletions as client 1 may delete and then
 * client 2 updates afterwards
 * e.g. {id: 1, title: 'one'}, {$id: 1, $deleted: true}, {$id: 1, title: 'two'}
 */
function removeDeletions(db, doc, deletions) {
  var promises = [];
  doc.rows.forEach(function (el) {
    if (deletions[el.doc.$id]) { // deleted?
      promises.push(getAndRemove(db, el.id));
    }
  });
  // promise shouldn't resolve until all deletions have completed
  return Promise.all(promises);
}

function cleanupDoc(db, el, docs, deletions) {

  return db.get(el.doc._id).then(function (object) {

    if (!el.doc.$id) { // first delta for doc?
      el.doc.$id = el.doc._id;
    }

    if (el.doc.$deleted || deletions[el.doc.$id]) { // deleted?
      deletions[el.doc.$id] = true;
      return db.remove(object);
    } else if (docs[el.doc.$id]) { // exists?
      var undef = false;
      for (var k in el.doc) {
        if (typeof docs[el.doc.$id][k] === 'undefined') {
          undef = true;
          break;
        }
      }
      if (undef) {
        docs[el.doc.$id] = exports.merge(docs[el.doc.$id], el.doc);
      } else { // duplicate update, remove
        return db.remove(object);
      }
    } else {
      docs[el.doc.$id] = el.doc;
    }
  });
}

var cleanupFactory = function (db, el, docs, deletions) {
  return function () {
    return cleanupDoc(db, el, docs, deletions);
  };
};

// TODO: also create fn like noBufferCleanup that uses REST to cleanup??
//       This way can use timestamp so not cleaning same range each time
exports.cleanup = function () {
  var db = this;
  return db.allDocs({ include_docs: true }).then(function (doc) {

    var docs = {}, deletions = {}, chain = Promise.resolve();

    // The cleanupDoc() calls must execute in sequential order
    doc.rows.forEach(function (el) {
      chain = chain.then(cleanupFactory(db, el, docs, deletions));
    });

    return chain.then(function () {
      if (!empty(deletions)) {
        return removeDeletions(db, doc, deletions);
      }
    });

  });
};

function onChange(doc) { 
  if (!doc._conflicts) return;
    collectConflicts(doc._conflicts, function(docs) {
      var master = docs.sort(byTime).unshift();
      for (var doc in docs) {
        for (var prop in doc) {
          if (!(prop in master)) { 
            master[prop] = doc[prop];
          } 
        }
      }
      db.put(master, function(err) {
        if (!err) { 
          for (var doc in docs) {
            db.remove(doc);
          }
        }
      });     
    });
  }
}

exports.monitorAndResolveConflicts = function () {
  this.changes({conflicts: true, onChange: onChange});
}

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.plugin(exports);
}
